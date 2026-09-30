#!/usr/bin/env python3
"""Official AutomationBench environment only. Models and tool admission belong to Ditto."""
import argparse
import asyncio
import contextlib
import json
import sys
from functools import lru_cache

from automationbench.domains import DOMAINS
from automationbench.runner import AutomationBenchEnv
from automationbench.rubric import create_rubric, partial_credit, task_completed_correctly
from automationbench.schema.world import WorldState


@lru_cache(maxsize=None)
def dataset(domain):
    return DOMAINS[domain]()


def tasks(domains=None):
    for domain in domains or DOMAINS:
        for row in dataset(domain):
            if isinstance(row['info'], str):
                row['info'] = json.loads(row['info'])
            row['domain'] = domain
            yield row


async def serve():
    sessions = {}
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                op = request['op']
                session = request['session']
                state, env = sessions.get(session, (None, None))
                if op == 'start':
                    domain = request['taskId'].split('.')[0]
                    row = next(r for r in tasks([domain]) if r['info']['task_name'] == request['taskId'])
                    env = AutomationBenchEnv(dataset=dataset(domain), rubric=create_rubric(), toolset='api')
                    state = await env.setup_state(row)
                    sessions[session] = (state, env)
                    result = {'tools': env._all_oai_tools, 'contract': state['_task_contract_sha256']}
                elif op == 'close':
                    sessions.pop(session, None)
                    result = None
                elif state is None:
                    raise ValueError('Start a task before using its environment')
                elif op == 'call':
                    args = env.update_tool_args(request['name'], request['arguments'], [], state)
                    output = await env.call_tool(request['name'], args, 'external')
                    result = {'content': output.content}
                elif op == 'snapshot':
                    result = {'world': state['world'].model_dump(mode='json'), 'contract': state['_task_contract_sha256']}
                elif op == 'grade':
                    if request['contract'] != state['_task_contract_sha256']:
                        raise ValueError('Task contract changed')
                    state['world'] = WorldState.model_validate(request['world'])
                    credit = partial_credit(state)
                    result = {'score': int(task_completed_correctly(state)), 'partialCredit': credit,
                              'assertions': state['_assertion_results']}
                else:
                    raise ValueError('Unknown bridge operation')
            print(json.dumps({'ok': True, 'result': result}), flush=True)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': str(e)}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--export')
    args = p.parse_args()
    if args.export:
        with open(args.export, 'w', encoding='utf-8') as f:
            for row in tasks():
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
    else:
        asyncio.run(serve())
