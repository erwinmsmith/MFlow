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

    class ProviderUnavailable(BaseException):
        """Abort the search without scoring an unavailable provider as policy failure."""

    class ControllerFailure(BaseException):
        """Do not advance search rounds after optimizer infrastructure failures."""

    def rpc(route, data=None):
        req = urllib.request.Request(endpoint + '/' + route, data=json.dumps(data or {}).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=None) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read().decode()
            if json.loads(body).get('unavailable'):
                raise ProviderUnavailable(body) from None
            if json.loads(body).get('fatal'):
                raise ControllerFailure(body) from None
            raise RuntimeError(body) from None

    init = rpc('bootstrap')
    static = init.get('mode') == 'aflow-static'
    if static:
        from automation_aflow import prepare, write_static, evaluate_static, sample
        prepare(Path(out), Path(source))
    config = init['config']
    if not static and len(init.get('seeds', [])) != 1:
        raise ValueError('MFlow requires one single-agent root; explore topology through descendant mutations')
    random.seed(config['seed'])
    np.random.seed(config['seed'])
    llm = LLMConfig({'model': 'ditto', 'key': 'local', 'base_url': endpoint})
    dataset = init.get('dataset', 'MATH')
    optimizer = Optimizer(dataset=dataset, question_type='organization strategy for ' + init.get('questionType', 'mathematical reasoning'), opt_llm_config=llm,
                          exec_llm_config=llm, operators=[], sample=4, check_convergence=True,
                          optimized_path=str(out / 'workspace') if static else str(out), initial_round=1, max_rounds=1,
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
        (path / 'strategy.json').write_text(json.dumps({'id': f's{number}', **json.loads(response['graph']), 'prompts': json.loads(response['prompt'])}, indent=2) + '\n')
        if static:write_static(path, json.loads(response['graph'])['composition'], json.loads(response['prompt']), number)

    if not (workflows / 'round_1/strategy.json').exists():
        write_graph(workflows / 'round_1', {'graph': json.dumps({'composition': init['composition'], 'organization': init['organization']}), 'prompt': json.dumps(init['prompts'])}, 1, dataset)

    def execution_context(number, path):
        directory = Path(path) / f'round_{number}'
        return [json.loads(p.read_text()) for p in sorted(directory.glob('organization_*.json'))]

    def read_graph(number, path):
        strategy = json.loads((Path(path) / f'round_{number}/strategy.json').read_text())
        if static:return strategy['prompts'], strategy['composition']
        return json.dumps(strategy['prompts']), json.dumps({'composition': strategy['composition'], 'organization': strategy['organization'], 'parent_execution': execution_context(number, path)})

    optimizer.graph_utils.write_graph_files = write_graph
    optimizer.graph_utils.read_graph_files = read_graph
    optimizer.graph_utils.extract_solve_graph = lambda code: [code]
    optimizer.graph_utils.load_graph = lambda number, path: number
    optimizer.graph_utils.load_operators_description = lambda _: init['interface']

    original_prompt = optimizer.graph_utils.create_graph_optimize_prompt
    def branch_history():
        # No task text or answers: give structural coverage across the existing tree.
        # Native AFlow still selects parents and supplies parent-specific experience.
        records = optimizer.data_utils.load_results(str(workflows))
        grouped = {}
        for row in records:
            grouped.setdefault(row['round'], []).append(row['score'])
        history = []
        for number, scores in sorted(grouped.items()):
            if len(scores) != config['validationRounds']:
                continue
            directory = workflows / f'round_{number}'
            strategy = json.loads((directory / 'strategy.json').read_text())
            experience_path = directory / 'experience.json'
            experience = json.loads(experience_path.read_text()) if experience_path.exists() else {}
            summaries = execution_context(number, workflows)
            actions, node_types = {}, set()
            for summary in summaries:
                for name, count in summary.get('actions', {}).items():
                    actions[name] = actions.get(name, 0) + count
                for example in summary.get('examples', []):
                    node_types.update((example.get('organization') or {}).get('nodeCalls', {}))
            history.append({'round': number, 'parentRound': experience.get('father node'),
                            'score': sum(scores) / len(scores), 'modification': experience.get('modification', 'Single-agent root'),
                            'actions': actions, 'executedNodeTypes': sorted(node_types),
                            'templates': [{'id': t['id'], 'nodes': t['profile'].get('nodes', []),
                                           'reasoning': t['profile'].get('reasoning'), 'tools': t['profile'].get('tools', [])}
                                          for t in strategy['organization'].get('agentTemplates', [])],
                            'toolLibrary': [t['name'] for t in strategy['organization'].get('toolLibrary', [])]})
        return history

    def prompt(experience, score, graph, prompts, operator_description, type, log_data):
        if static:return original_prompt(experience,score,graph,prompts,init['interface'],type,log_data)+'\n'+init['interface']
        # Keep AFlow's single-change, complete artifact, feedback and experience instructions.
        # Language/import instructions are replaced because the search object is a native Ditto Graph/Loop composition.
        user = WORKFLOW_INPUT.format(experience=experience, score=score, graph=graph, prompt=prompts,
                                    operator_description=operator_description, type=type, log=log_data)
        user = user.replace('and no more than 5 lines of code may be changed per modification—extensive modifications are strictly prohibited to maintain project focus!',
                            'including all node definitions, profiles, bindings and control code needed to implement that one coherent structural change. No line-count limit applies.')
        start = user.index('When introducing new functionalities')
        end = user.index('**Under no circumstances', start)
        user = user[:start] + 'Generate complete JavaScript composition code returning a native Ditto loop plan, plus a complete JSON prompt map. No imports.\n' + user[end:]
        user = user.replace('You do not need to manually import prompt_custom or operator to use them; they are already included in the execution environment.', '')
        system = WORKFLOW_OPTIMIZE_PROMPT.format(type=type)
        system = system.replace("Python's", "JavaScript's")
        system = system.replace('The graph \ncomplexity should not exceed 10.', 'Choose graph size from the measured task requirements; no fixed node-count limit applies.')
        system = system.replace('single modification in XML tags in your reply.', 'single modification in the required structured response.')
        # Replace Custom-specific prompt restrictions, not the optimization procedure.
        begin = system.index('The prompt you need to generate')
        end = system.index('Considering information loss', begin)
        system = system[:begin] + 'Generate the complete JSON map of agent, factory, review, integrate and retrieve prompts. All five fields are editable.\n' + system[end:]
        return system + '\nParent execution contains measured capability configurations and evolving graphs. Preserve useful population members, their internal graphs/loops, the complete agentTemplates library, initialBindings and dynamic MAS routing from this parent, and make one focused change. The candidate jointly defines the MAS and its reusable agents; template-only optimization must not discard the outer derivation policy. Do not copy task answers or episodic memory into reusable profiles. Return composition and organization only as executable fields; parent_execution is evidence.\n' + user + '\nsearch_branch_history: ' + json.dumps(branch_history()) + '\n' + init['interface'] + '\nReturn modification, organization, composition and prompts according to the response schema. The strategy dynamically composes heterogeneous agents using native graphs and loops. Preserve and evolve their different internal node structures and cross-agent bindings; do not embed benchmark answers.'

    optimizer.graph_utils.create_graph_optimize_prompt = prompt

    original_format = AsyncLLM.call_with_format
    async def propose(self, prompt, formatter):
        if static and getattr(getattr(formatter,'model',None),'__name__','')!='GraphOptimize':
            return await original_format(self,prompt,formatter)
        result = await asyncio.to_thread(rpc, 'propose', {'round': optimizer.round + 1, 'prompt': prompt})
        if static:
            from repairs import validate_workflow
            for attempt in range(3):
                try:result=validate_workflow(result);break
                except (SyntaxError,ValueError,KeyError) as error:
                    if attempt==2:raise
                    result=await asyncio.to_thread(rpc,'propose',{'round':optimizer.round+1,'prompt':'Repair syntax/serialization only. Preserve the workflow and prompts.\n'+json.dumps(result)+'\n'+str(error)})
            return {'modification':result['modification'],'graph':json.dumps({'composition':result['graph'],'organization':{}}),'prompt':json.dumps(result['prompt'])}
        return {'modification': result['modification'], 'graph': json.dumps({'composition': result['composition'], 'organization': result['organization']}), 'prompt': json.dumps(result['prompts'])}
    AsyncLLM.call_with_format = propose
    # Prevent the native formatting fallback from bypassing Ditto.
    async def raw(self, prompt):
        if static:return await sample(prompt,self.sys_msg)
        raise RuntimeError('All optimizer calls must use the Ditto proposal adapter')
    AsyncLLM.__call__ = raw

    original_experience = optimizer.experience_utils.create_experience_data
    def create_experience(parent, modification):
        experience = original_experience(parent, modification)
        directory = workflows / f'round_{optimizer.round + 1}'
        (directory / 'parent_context.json').write_text(json.dumps({
            'parentRound': parent['round'],
            'strategy': json.loads((workflows / f"round_{parent['round']}" / 'strategy.json').read_text()),
            'execution': execution_context(parent['round'], workflows),
        }, indent=2) + '\n')
        checkpoint.update(round=optimizer.round, phase='evaluating', parentRound=parent['round'], experience=experience)
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
            if static:
                try:result = await evaluate_static(number,repeat,strategy,config['concurrency'])
                except Exception as error:raise ControllerFailure(str(error)) from error
            else:result = await asyncio.to_thread(rpc, 'evaluate', {'round': number, 'repeat': repeat, 'strategy': strategy})
            (Path(directory) / f'organization_{repeat}.json').write_text(json.dumps(result['organizationSummary'], indent=2) + '\n')
            (Path(directory) / f'failures_{repeat}.json').write_text(json.dumps(result['failures']) + '\n')
            failures = []
            for prior in range(repeat + 1):
                failures.extend(json.loads((Path(directory) / f'failures_{prior}.json').read_text()))
            (Path(directory) / 'log.json').write_text(json.dumps(failures, indent=2) + '\n')
            return result['score'], result['meanTokens'], result['tokens']
        Evaluator.graph_evaluate = graph_evaluate
        try:
            score = await original_evaluate(optimizer, directory, validation_n, data, initial)
            # One-way export only. The observer owns test data, scores and failures.
            await asyncio.to_thread(rpc, 'checkpoint-round', {'round': number, 'score': score,
                'strategy': json.loads((Path(directory) / 'strategy.json').read_text())})
            return score
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
    seeds = init.get('seeds', [])
    if static and len(seeds) > 1 and checkpoint.get('seedRound', 1) <= len(seeds):
        # Every root receives the same complete repetitions before native parent sampling.
        for number in range(checkpoint.get('seedRound', 1), len(seeds) + 1):
            seed = seeds[number - 1]
            directory = workflows / f'round_{number}'
            if not (directory / 'strategy.json').exists():
                write_graph(directory, {'graph': json.dumps({'composition': seed['composition'], 'organization': seed['organization']}), 'prompt': json.dumps(seed['prompts'])}, number, dataset)
                (directory / 'initialization.json').write_text(json.dumps({'name': seed['name'], 'root': True}) + '\n')
            checkpoint.update(phase='seeding', seedRound=number)
            persist()
            optimizer.round = number
            optimizer.graph = number
            data = optimizer.data_utils.load_results(str(workflows))
            asyncio.run(evaluate(optimizer, str(directory), optimizer.validation_rounds, data, initial=True))
            checkpoint.update(seedRound=number + 1, round=number, phase='generating')
            persist()
        optimizer.round = len(seeds)
    # Run the native loop one iteration at a time, with no arbitrary total cap.
    # Never use an interrupted candidate's partial repetitions to declare convergence.
    # MFlow has one root; every later measured candidate is a real mutation.
    converged = lambda: (not static or not seeds or optimizer.round >= len(seeds) + 5) and checkpoint['phase'] not in ('evaluating', 'seeding') and optimizer.round > max(1, len(seeds)) and optimizer.convergence_utils.check_convergence(top_k=3)[0]
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
