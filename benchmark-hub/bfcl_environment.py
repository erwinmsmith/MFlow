"""One official BFCL world per conversation; JSONL external-tool adapter, no model SDK."""
import argparse
import ast
import contextlib
import copy
import json
import os
import sys
from pathlib import Path
from bfcl_bridge import literal_call

CONTRACT = 'bfcl-shared-conversation-v1'


class Conversation:
    def __init__(self, official, task_id):
        self.official = official
        self.category = task_id.rsplit('_', 1)[0]
        if self.category not in ('multi_turn_base', 'multi_turn_miss_param', 'multi_turn_miss_func', 'multi_turn_long_context'):
            raise ValueError('Unsupported BFCL category')
        from bfcl_eval.utils import populate_test_cases_with_predefined_functions
        self.original = self.load(task_id)
        self.entry = populate_test_cases_with_predefined_functions([copy.deepcopy(self.original)])[0]
        self.turn = 0; self.steps = 0; self.complete = False; self.forced = False
        self.results = [[]]; self.history = []; self.unavailable = []
        self.functions = list(self.entry['function'])
        self.scope = (self.entry.get('initial_config', {}), self.entry['involved_classes'], 'ditto_shared', task_id)
        self.execute([])
        self.reveal()

    def load(self, task_id, gold=False):
        path = self.official / 'bfcl_eval/data'
        if gold: path /= 'possible_answer'
        return next(r for r in map(json.loads, (path / f'BFCL_v4_{self.category}.json').read_text().splitlines()) if r['id'] == task_id)

    def execute(self, calls):
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
        return execute_multi_turn_func_call(calls, *self.scope, long_context='long_context' in self.category)[0]

    def reveal(self):
        messages = copy.deepcopy(self.entry['question'][self.turn])
        held = self.entry.get('missed_function', {}).get(str(self.turn))
        if held:
            from bfcl_eval.constants.default_prompts import DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC
            self.functions.extend(held)
            assert not messages
            messages = [{'role': 'user', 'content': DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC}]
        self.history.extend(messages)

    def state(self):
        # Public messages and observations only. No initial_config, future turns or gold.
        return {'turn': self.turn, 'complete': self.complete, 'forced': self.forced,
                'history': self.history, 'functions': self.functions}

    def call(self, name, args):
        if name == 'bfcl_state': return self.state()
        if self.complete: return {'complete': True, 'error': 'Conversation ended; do not execute further actions.'}
        if type(args.get('turn')) is not int or args['turn'] != self.turn:
            return {'error': 'Stale or missing turn; call bfcl_state before acting.', 'turn': self.turn}
        if name == 'bfcl_respond':
            if not isinstance(args.get('message'), str): raise ValueError('message must be a string')
            self.results[-1].append(args['message'])
            self.history.append({'role': 'assistant', 'content': args['message']})
            self.turn += 1; self.steps = 0
            self.complete = self.turn == len(self.entry['question'])
            if not self.complete: self.results.append([]); self.reveal()
            return self.state()
        if name != 'bfcl_call': raise ValueError('Unknown interface tool')
        calls = args.get('calls')
        if not isinstance(calls, list) or not calls: raise ValueError('calls must be a nonempty list')
        sources = []; encoded = []; names = {f['name'] for f in self.functions}
        for call in calls:
            if not isinstance(call, dict) or not isinstance(call.get('arguments'), dict): raise ValueError('Each call needs name and arguments')
            fn = call.get('name')
            if fn not in names:
                self.unavailable.append(str(fn))
                return {'error': f'Unavailable function: {fn}. Read the current function schemas; do not invent functions.'}
            if any(not k.isidentifier() for k in call['arguments']): raise ValueError('Invalid parameter name')
            source = fn + '(' + ','.join(k + '=' + repr(v) for k, v in call['arguments'].items()) + ')'
            literal_call(source)
            sources.append(source); encoded.append({fn: json.dumps(call['arguments'])})
        observations = self.execute(sources)
        self.results[-1].append(encoded)
        self.history.append({'role': 'assistant', 'calls': calls})
        self.history.extend({'role': 'tool', 'name': call['name'], 'content': obs} for call, obs in zip(calls, observations))
        self.steps += 1
        from bfcl_eval.constants.default_prompts import MAXIMUM_STEP_LIMIT
        if self.steps > MAXIMUM_STEP_LIMIT: self.forced = self.complete = True
        return {'turn': self.turn, 'observations': observations, 'complete': self.complete, 'forced': self.forced}

    def snapshot(self):
        return {'contract': CONTRACT, 'world': {'id': self.entry['id'], 'result': self.results,
                'unavailable': self.unavailable, 'forced': self.forced}}

    def grade(self, checkpoint):
        world = checkpoint['world']
        if checkpoint['contract'] != CONTRACT or world['id'] != self.entry['id']: raise ValueError('BFCL checkpoint mismatch')
        if world['unavailable']: return {'score': 0, 'partialCredit': 0, 'errorType': 'unavailable_tool'}
        if world['forced']: return {'score': 0, 'partialCredit': 0, 'errorType': 'force_terminated'}
        from bfcl_eval.model_handler.base_handler import BaseHandler
        from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler
        from bfcl_eval.constants.enums import ModelStyle
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import is_empty_execute_response
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker
        class Handler(OpenAICompletionsHandler):
            def __init__(self):
                BaseHandler.__init__(self, 'ditto_shared', 0, 'ditto-shared-FC', True)
                self.model_style = ModelStyle.OPENAI_COMPLETIONS
            def decode_execute(self, result, has_tool_call_tag):
                sources = super().decode_execute(result, has_tool_call_tag)
                for source in sources: literal_call(source)
                return sources
        handler = Handler()
        # Validate replay names turn-by-turn before the official eval-based executor.
        available = {f['name'] for f in self.entry['function']}
        for turn, steps in enumerate(world['result']):
            available.update(f['name'] for f in self.entry.get('missed_function', {}).get(str(turn), []))
            for step in steps:
                if isinstance(step, str): continue
                for source in handler.decode_execute(step, True):
                    if literal_call(source)['name'] not in available: raise ValueError('Unregistered replay function')
        path = self.official / 'bfcl_eval/eval_checker/eval_runner.py'
        function = next(n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == '_evaluate_single_multi_turn_entry')
        namespace = {'BaseHandler': BaseHandler, 'multi_turn_checker': multi_turn_checker, 'is_empty_execute_response': is_empty_execute_response}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        # References are read only after execution has ended, never included in tool observations.
        result = namespace[function.name](handler, self.entry['id'], world['result'], self.load(self.entry['id'], gold=True)['ground_truth'], self.original, 'ditto_shared', self.category)
        score = int(result['valid'])
        return {'score': score, 'partialCredit': score, 'errorType': result.get('error', {}).get('error_type')}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--official', type=Path, required=True); parser.add_argument('--task', required=True)
    args = parser.parse_args(); sys.path.insert(0, str(args.official))
    os.environ['BFCL_PROJECT_ROOT'] = str(args.official)
    with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet):
        env = Conversation(args.official, args.task)
        for line in sys.stdin:
            try:
                req = json.loads(line)
                if req['op'] == 'state': result = env.state()
                elif req['op'] == 'call':
                    try: result = env.call(req['name'], req['arguments'])
                    except (ValueError, TypeError, KeyError) as exc: result = {'error': str(exc), 'turn': env.turn}
                elif req['op'] == 'snapshot': result = env.snapshot()
                elif req['op'] == 'grade': result = env.grade(req)
                else: raise ValueError('Unknown operation')
                response = {'ok': True, 'result': result}
            except Exception as exc: response = {'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
            print(json.dumps(response), file=sys.__stdout__, flush=True)

if __name__ == '__main__': main()
