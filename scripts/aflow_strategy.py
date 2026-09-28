"""Official AFlow controller, with strategy representation and Ditto evaluation adapters.

No optimizer, parent sampler, experience filter, or convergence code is copied here.
"""
import asyncio
import json
import os
import random
import sys
import urllib.request
import urllib.error
from pathlib import Path


def main():
    endpoint, source, out = sys.argv[1:]
    out = Path(out).resolve()
    # Local scripts/benchmarks.py must not shadow the official benchmarks package.
    sys.path = [str(Path(source).resolve())] + [p for p in sys.path if Path(p).resolve() != Path(__file__).resolve().parent]
    from scripts.async_llm import AsyncLLM, LLMConfig
    from scripts.optimizer import Optimizer
    from scripts.evaluator import Evaluator
    from scripts.prompts.optimize_prompt import WORKFLOW_INPUT, WORKFLOW_OPTIMIZE_PROMPT
    import numpy as np

    def rpc(route, data=None):
        req = urllib.request.Request(endpoint + '/' + route, data=json.dumps(data or {}).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=None) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from None

    init = rpc('bootstrap')
    config = init['config']
    random.seed(config['seed'])
    np.random.seed(config['seed'])
    llm = LLMConfig({'model': 'ditto', 'key': 'local', 'base_url': endpoint})
    optimizer = Optimizer(dataset='MATH', question_type='organization strategy', opt_llm_config=llm,
                          exec_llm_config=llm, operators=[], sample=4, check_convergence=True,
                          optimized_path=str(out), initial_round=1, max_rounds=1,
                          validation_rounds=config['validationRounds'])
    workflows = Path(optimizer.root_path) / 'workflows'
    workflows.mkdir(parents=True, exist_ok=True)
    checkpoint_path = out / 'controller.json'
    checkpoint = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {'round': 1, 'phase': 'generating'}

    def persist():
        checkpoint['random'] = random.getstate()
        state = np.random.get_state()
        checkpoint['numpy'] = [state[0], state[1].tolist(), int(state[2]), int(state[3]), float(state[4])]
        temp = checkpoint_path.with_suffix('.tmp')
        temp.write_text(json.dumps(checkpoint, indent=2) + '\n')
        os.replace(temp, checkpoint_path)

    if 'random' in checkpoint:
        def tuples(value):
            return tuple(tuples(x) for x in value) if isinstance(value, list) else value
        random.setstate(tuples(checkpoint['random']))
        state = checkpoint['numpy']
        np.random.set_state((state[0], np.array(state[1], dtype=np.uint32), *state[2:]))

    def write_graph(directory, response, number, dataset):
        path = Path(directory)
        path.mkdir(parents=True, exist_ok=True)
        (path / 'strategy.json').write_text(json.dumps({'id': f's{number}', 'program': response['graph'], 'prompts': json.loads(response['prompt'])}, indent=2) + '\n')

    if not (workflows / 'round_1/strategy.json').exists():
        write_graph(workflows / 'round_1', {'graph': init['program'], 'prompt': json.dumps(init['prompts'])}, 1, 'MATH')

    def read_graph(number, path):
        strategy = json.loads((Path(path) / f'round_{number}/strategy.json').read_text())
        return json.dumps(strategy['prompts']), strategy['program']

    optimizer.graph_utils.write_graph_files = write_graph
    optimizer.graph_utils.read_graph_files = read_graph
    optimizer.graph_utils.extract_solve_graph = lambda code: [code]
    optimizer.graph_utils.load_graph = lambda number, path: number
    optimizer.graph_utils.load_operators_description = lambda _: init['interface']

    def prompt(experience, score, graph, prompts, operator_description, type, log_data):
        # Keep AFlow's single-change, complete artifact, feedback and experience instructions.
        # Language/import instructions are replaced because the search object is a pure JS policy.
        user = WORKFLOW_INPUT.format(experience=experience, score=score, graph=graph, prompt=prompts,
                                    operator_description=operator_description, type=type, log=log_data)
        start = user.index('When introducing new functionalities')
        end = user.index('**Under no circumstances', start)
        user = user[:start] + 'Generate a complete JavaScript policy function BODY and a complete JSON prompt map. No imports.\n' + user[end:]
        user = user.replace('You do not need to manually import prompt_custom or operator to use them; they are already included in the execution environment.', '')
        system = WORKFLOW_OPTIMIZE_PROMPT.format(type=type)
        system = system.replace("Python's", "JavaScript's")
        # Replace Custom-specific prompt restrictions, not the optimization procedure.
        begin = system.index('The prompt you need to generate')
        end = system.index('Considering information loss', begin)
        system = system[:begin] + 'Generate the complete JSON map of agent, factory, review, integrate and retrieve prompts. All five fields are editable.\n' + system[end:]
        return system + '\n' + user + '\n' + init['interface'] + '\nReturn modification, program and prompts according to the response schema. The strategy dynamically organizes agents; do not generate a fixed task-specific graph or benchmark answers.'

    optimizer.graph_utils.create_graph_optimize_prompt = prompt

    async def propose(self, prompt, formatter):
        result = await asyncio.to_thread(rpc, 'propose', {'round': optimizer.round + 1, 'prompt': prompt})
        return {'modification': result['modification'], 'graph': result['program'], 'prompt': json.dumps(result['prompts'])}
    AsyncLLM.call_with_format = propose
    # Prevent the native formatting fallback from bypassing Ditto.
    async def raw(self, prompt):
        raise RuntimeError('All optimizer calls must use the Ditto proposal adapter')
    AsyncLLM.__call__ = raw

    original_experience = optimizer.experience_utils.create_experience_data
    def create_experience(parent, modification):
        experience = original_experience(parent, modification)
        checkpoint.update(round=optimizer.round, phase='evaluating', experience=experience)
        persist()
        return experience
    optimizer.experience_utils.create_experience_data = create_experience

    original_evaluate = optimizer.evaluation_utils.evaluate_graph
    async def evaluate(optimizer, directory, validation_n, data, initial=False):
        number = optimizer.round if initial else optimizer.round + 1
        # Exactly one full independent pass per native validation repetition.
        # Committed passes/tasks are reused only when resuming this same candidate/run.
        data[:] = [r for r in data if r['round'] != number]
        pass_index = 0
        async def graph_evaluate(self, dataset, graph, params, directory, is_test=False):
            nonlocal pass_index
            repeat = pass_index
            pass_index += 1
            strategy = json.loads((Path(directory) / 'strategy.json').read_text())
            result = await asyncio.to_thread(rpc, 'evaluate', {'round': number, 'repeat': repeat, 'strategy': strategy})
            (Path(directory) / f'failures_{repeat}.json').write_text(json.dumps(result['failures']) + '\n')
            failures = []
            for prior in range(repeat + 1):
                failures.extend(json.loads((Path(directory) / f'failures_{prior}.json').read_text()))
            (Path(directory) / 'log.json').write_text(json.dumps(failures, indent=2) + '\n')
            return result['score'], result['meanTokens'], result['tokens']
        Evaluator.graph_evaluate = graph_evaluate
        try:
            return await original_evaluate(optimizer, directory, validation_n, data, initial)
        except Exception:
            # A technical failure is not zero accuracy or a partially eligible parent.
            data[:] = [r for r in data if r['round'] != number]
            optimizer.data_utils.save_results(str(workflows / 'results.json'), data)
            raise
    optimizer.evaluation_utils.evaluate_graph = evaluate

    original_optimize = optimizer._optimize_graph
    async def optimize_round():
        try:
            if checkpoint['phase'] == 'evaluating':
                directory = workflows / f'round_{optimizer.round + 1}'
                optimizer.graph = optimizer.round + 1
                data = optimizer.data_utils.load_results(str(workflows))
                score = await evaluate(optimizer, str(directory), optimizer.validation_rounds, data)
                optimizer.experience_utils.update_experience(str(directory), checkpoint['experience'], score)
            else:
                checkpoint.update(round=optimizer.round, phase='generating')
                persist()
                score = await original_optimize()
        except Exception:
            # Preserve native skip-on-error behavior, including its round counter.
            checkpoint.update(round=optimizer.round + 1, phase='generating')
            checkpoint.pop('experience', None)
            persist()
            raise
        checkpoint.update(round=optimizer.round + 1, phase='generating')
        checkpoint.pop('experience', None)
        persist()
        return score
    optimizer._optimize_graph = optimize_round
    optimizer.round = checkpoint['round']
    # Run the native loop one iteration at a time, with no arbitrary total cap.
    # Never use an interrupted candidate's partial repetitions to declare convergence.
    converged = lambda: checkpoint['phase'] != 'evaluating' and optimizer.convergence_utils.check_convergence(top_k=3)[0]
    while (checkpoint['phase'] != 'finished' and not converged()
           and (config['maxRounds'] is None or optimizer.round <= config['maxRounds'])):
        optimizer.optimize('Graph')
    checkpoint.update(phase='finished', round=optimizer.round,
                      stopReason='converged' if converged() else 'max_rounds')
    persist()
    records = optimizer.data_utils.load_results(str(workflows))
    grouped = {}
    for record in records:
        grouped.setdefault(record['round'], []).append(record['score'])
    complete = [(sum(scores) / len(scores), number) for number, scores in grouped.items() if len(scores) == config['validationRounds']]
    if not complete:
        raise RuntimeError('No fully evaluated candidate; refuse to export')
    score, number = max(complete, key=lambda item: (item[0], -item[1]))
    rpc('freeze', {'round': number, 'score': score, 'stopReason': checkpoint['stopReason'], 'strategy': json.loads((workflows / f'round_{number}/strategy.json').read_text())})


if __name__ == '__main__':
    main()
