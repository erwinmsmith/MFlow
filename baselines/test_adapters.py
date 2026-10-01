"""Offline checks. Run with the legacy environment; no model calls are made."""
import contextlib
import os
import subprocess
import io
import json
import tempfile
import unittest
import runpy
import sys
import types
from pathlib import Path
from unittest.mock import patch

import bench_common as common
from dylan import DyLAN
from evoagent import EvoAgent
from repairs import parse_roles, validate_workflow, validate_role_plan, install_aflow_python


class AdapterTests(unittest.TestCase):
    def test_bad_model_output_is_quality_failure_and_http_outage_stops(self):
        import urllib.error
        token=common.SCOPE.set(('AFlow','search','fixture'))
        try:
            for message,kind in [('[INVALID_MODEL_OUTPUT] malformed action JSON',common.ModelOutputFailure),('{"code":"INVALID_MODEL_OUTPUT","message":"duplicate action ID"}',common.ModelOutputFailure),('[DEGENERATE_OUTPUT] repeated output',common.ModelOutputFailure),('[MODEL_CONTEXT_LIMIT] HTTP 400: maximum context length exceeded',common.ModelOutputFailure),('Model provider returned HTTP 402',common.TransportFailure)]:
                error=urllib.error.HTTPError('http://fixture',502,'fixture',{},io.BytesIO(json.dumps({'error':message}).encode()))
                with patch.object(common.urllib.request,'urlopen',side_effect=error):
                    with self.assertRaises(kind):common.call([{'role':'user','content':'fixture'}])
        finally:common.SCOPE.reset(token)

    def test_replacement_episode_uses_fresh_scope_and_shared_ledger(self):
        import automation_run as runner
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);out=root/'AutoAgents/pilot';out.mkdir(parents=True)
            ledger=root/'shared-usage.jsonl'
            ledger.write_text('\n'.join(json.dumps({'method':'AutoAgents','phase':'AutoAgents:pilot','taskId':task_id,'charged':tokens}) for task_id,tokens in [('fixture',30),('new/fixture',7)])+'\n')
            token=common.SCOPE.set(('fixture','fixture','fixture'))
            try:
                with patch.dict(os.environ,{'MFLOW_BASELINE_EXECUTION_NAMESPACE':'new/','MFLOW_BASELINE_USAGE_PATH':str(ledger)}),patch.object(runner,'RUNS',root),patch.object(runner,'method',types.SimpleNamespace(solve=lambda prompt:'executed')),patch.object(common.urllib.request,'urlopen') as send:
                    send.return_value.__enter__.side_effect=[io.StringIO('{"checkpoint":false}'),io.StringIO('{"score":1,"partialCredit":1}')]
                    row=runner.episode('AutoAgents','pilot',{'id':'fixture','prompt':'fixture'})
                    bodies=[json.loads(call.args[0].data) for call in send.call_args_list]
                self.assertEqual(row['tokens'],7)
                self.assertEqual(row['taskId'],'fixture')
                self.assertFalse(row['checkpointRecovered'])
                self.assertTrue(all(body['taskId']=='new/fixture' and body['benchmarkTaskId']=='fixture' for body in bodies))
            finally:common.SCOPE.reset(token)

    def test_progress_replacement_reports_live_status_and_separate_cost(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('experiment',common.ROOT/'scripts/automation_experiment.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);replacement=root/'replacement/AutoAgents';(replacement/'pilot').mkdir(parents=True)
            (root/'jobs.json').write_text(json.dumps({'jobs':{'AutoAgents':{'status':'failed'}}}))
            (root/'method-outputs.json').write_text(json.dumps({'AutoAgents':{'output':str(replacement),'service':'replacement.service','executionNamespace':'new/'}}))
            (replacement/'pilot/status.json').write_text('{"status":"running","completed":1}')
            (root/'usage.jsonl').write_text('\n'.join(json.dumps({'method':'AutoAgents','phase':'AutoAgents:pilot','taskId':task_id,'charged':tokens,'unknownUsage':False}) for task_id,tokens in [('fixture',30),('new/fixture',7)])+'\n')
            with patch.object(runner.urllib.request,'urlopen',side_effect=OSError),patch.object(runner.subprocess,'run',side_effect=OSError),contextlib.redirect_stdout(io.StringIO()) as output:runner.status(root)
            result=json.loads(output.getvalue())
            self.assertEqual(result['jobs']['AutoAgents']['status'],'running')
            self.assertEqual(result['methods']['AutoAgents']['originalJob']['status'],'failed')
            self.assertEqual(result['baselineCost']['AutoAgents']['knownTokens'],37)
            self.assertEqual(result['baselineCost']['AutoAgents']['replacementCost']['knownTokens'],7)

    def test_sequential_experiment_preserves_stages_and_runs_one_method_at_a_time(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('experiment',common.ROOT/'scripts/automation_experiment.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        live=set();commands=[]
        class Child:
            def __init__(self,command,**kwargs):
                self.bridge='baselines/bridge.mjs' in command;self.pid=len(commands)+1;self.command=command
                if not self.bridge:
                    self.assert_single();live.add(self.pid);commands.append(command)
            def assert_single(self):
                if live:raise AssertionError('overlapping methods')
            def poll(self):
                if self.bridge:return None
                live.discard(self.pid);return 0
            def terminate(self):live.discard(self.pid)
            def wait(self,**kwargs):return 0
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'configs').mkdir()
            (root/'configs/hb-baselines.json').write_text(json.dumps({'runDirectory':'runs/check'}))
            (root/'package-lock.json').write_text('{}')
            with patch.object(runner,'ROOT',root),patch.dict(os.environ,{'MFLOW_MODEL':'qwen3.5-9b','BENCHMARK_HOME':directory}),patch.object(sys,'argv',['experiment','--benchmark','math','--sequential']),patch.object(runner.subprocess,'Popen',Child),patch.object(runner.time,'sleep'),patch.object(runner.urllib.request,'urlopen',return_value=io.StringIO('{"runDirectory":"runs/check"}')):
                runner.main()
            self.assertEqual([command[3] for command in commands[:2]],['search','evaluate'])
            self.assertEqual([Path(command[1]).name for command in commands[2:]],['aflow.py','run.py','run.py','run.py'])
            self.assertEqual([command[2] for command in commands[3:]],['DyLAN','EvoAgent','AutoAgents'])
            jobs=json.loads((root/'runs/check/jobs.json').read_text())['jobs']
            self.assertEqual({job['status'] for job in jobs.values()},{'completed'})
            self.assertEqual(json.loads((root/'runs/check/experiment-manifest.json').read_text())['schedule'],'sequential')

    def test_autoagents_planner_knows_actor_api_capabilities_without_execution_access(self):
        import asyncio
        import autoagents_adapter as adapter
        original=os.getcwd()
        try:
            with patch.dict(common.PROTOCOL,{'benchmark':'automationbench'}),patch.object(adapter,'call',return_value='fixture') as invoke:
                adapter.AutoAgents()
                llm=sys.modules['autoagents.system.provider.llm_api'].LLMAPI()
                asyncio.run(llm.aask('You are a manager and expert prompt engineer.'))
                self.assertFalse(invoke.call_args.kwargs['tools'])
                self.assertIn('api_fetch performs real reads and writes',invoke.call_args.args[0][0]['content'])
                asyncio.run(llm.aask('Execute this workflow.'))
                self.assertTrue(invoke.call_args.kwargs['tools'])
        finally:os.chdir(original)

    def test_hle_shared_jsonl_preserves_unicode_question_separators(self):
        with patch.dict(common.PROTOCOL,{'benchmark':'hle','datasetProtocol':'hle-full-holdout-v1'}):
            search,test=common.tasks('search'),common.tasks('test')
        self.assertEqual((len(search),len(test)),(200,2300))
        self.assertFalse({t['id'] for t in search}&{t['id'] for t in test})
        self.assertEqual(sum(bool(t.get('images')) for t in search+test),342)

    def test_hle_retrieval_filters_answer_repositories_and_verbatim_queries(self):
        from search_provider import hle_rules
        check=hle_rules('In this distinctive academic question the original full text must never be copied verbatim to retrieve an answer key.')
        self.assertTrue(check(query='site:huggingface.co hle'))
        self.assertTrue(check(query='In this distinctive academic question the original full text must never be copied verbatim to retrieve an answer key.'))
        self.assertTrue(check(result={'href':'https://github.com/answers/hle','title':'answers','body':'data'}))
        self.assertIsNone(check(result={'href':'https://en.wikipedia.org/wiki/Entropy','title':'Entropy','body':'General thermodynamic definition'}))

    def test_hle_native_consensus_keeps_response_and_resume_keeps_answer_without_actor_repeat(self):
        import automation_run as runner
        method=DyLAN()
        response='Explanation: offline fixture.\nAnswer: B\nConfidence: 70%'
        with patch.dict(common.PROTOCOL,{'benchmark':'hle'}),patch('dylan.call',return_value=response) as invoke,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(method.solve('Offline academic fixture'),response)
            self.assertEqual(invoke.call_count,3)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'DyLAN/test').mkdir(parents=True)
            with patch.object(runner,'RUNS',root),patch.object(runner,'method',types.SimpleNamespace(solve=lambda _: (_ for _ in ()).throw(AssertionError('actor repeated')))),patch.object(runner,'usage',return_value=0),patch.object(runner,'benchmark_rpc',side_effect=[{'checkpoint':True,'answer':response},{'score':1,'partialCredit':1,'confidence':70}]) as rpc:
                row=runner.episode('DyLAN','test',{'id':'fixture','prompt':'question'})
            self.assertEqual(row['answer'],response)
            self.assertEqual(rpc.call_args.kwargs['answer'],response)

    def test_native_programmer_uses_scoped_ditto_python_without_host_execution(self):
        import asyncio
        import ast
        source=common.SOURCES/'AFlow/workspace/MATH/workflows/template/operator.py'
        function=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='run_code')
        namespace={}
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
        class Programmer:
            def __init__(self,*args):pass
            async def exec_code(self,*args):raise AssertionError('host execution')
        operator=types.SimpleNamespace(Programmer=Programmer,run_code=namespace['run_code'])
        original=operator.Programmer.exec_code
        token=common.SCOPE.set(('AFlow','pilot','fixture'))
        try:
            install_aflow_python(operator)
            with patch.object(operator,'run_code',side_effect=AssertionError('host execution')),patch.dict(os.environ,{'MFLOW_BASELINE_PORT':'8198'}),patch.object(common.urllib.request,'urlopen') as send:
                send.return_value.__enter__.return_value=io.StringIO('{"status":"success","content":"debug\\n[\\"Success\\",\\"1/2\\"]\\n"}')
                self.assertEqual(asyncio.run(operator.Programmer(None).exec_code('def solve(): return 0.5')),('Success','1/2'))
                request=send.call_args.args[0]
                self.assertEqual(request.full_url,'http://127.0.0.1:8198/python')
                body=json.loads(request.data)
                self.assertEqual((body['method'],body['phase'],body['taskId']),('AFlow','pilot','fixture'))
                self.assertIn('def run_code(',body['code'])
        finally:
            common.SCOPE.reset(token)
            operator.Programmer.exec_code=original

    def test_web_search_uses_selected_bridge_endpoint(self):
        token=common.SCOPE.set(('AutoAgents','pilot','fixture'))
        try:
            with patch.dict(os.environ,{'MFLOW_BASELINE_ENDPOINT':'http://127.0.0.1:8198'}),patch.object(common.urllib.request,'urlopen') as send:
                send.return_value.__enter__.return_value=io.StringIO('{"results":[]}')
                self.assertEqual(common.search_web('fixture'), '[]')
                self.assertEqual(send.call_args.args[0].full_url,'http://127.0.0.1:8198/search')
        finally:common.SCOPE.reset(token)

    def test_local_protocol_override_selects_qwen_and_separate_results(self):
        result=subprocess.run([sys.executable,'-c',
            'import bench_common as c; assert c.PROTOCOL["model"]=="qwen3.5-9b"; assert "hb-qwen" in str(c.RUNS); assert c.PROTOCOL_PATH.name=="hb-baselines.json"'],
            cwd=common.ROOT/'baselines',env={**os.environ,'MFLOW_BASELINE_PROTOCOL':'configs/hb-baselines.json'},capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_provider_output_limit_records_failed_task_and_continues(self):
        class Method:
            def solve(self,prompt):
                if prompt=='first':raise common.TransportFailure('Provider context/output ceiling reached; response is incomplete')
                return 'ok'
        with tempfile.TemporaryDirectory() as folder:
            rows=[{'id':'one','prompt':'first'},{'id':'two','prompt':'second'}]
            with patch.object(common,'RUNS',Path(folder)),patch.object(common,'tasks',return_value=rows),patch.object(common,'freeze_run'),patch.object(common,'usage',return_value=20),patch.object(common,'grade',side_effect=lambda task,answer:int(answer=='ok')),patch.dict(sys.modules,{'dylan':types.SimpleNamespace(DyLAN=Method)}),patch.object(sys,'argv',['run.py','DyLAN','--phase','test']),contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(common.ROOT/'baselines/run.py'))
            records=[json.loads(s) for s in (Path(folder)/'DyLAN/test/results.jsonl').read_text().splitlines()]
            self.assertEqual([r['status'] for r in records],['provider_output_limit','completed'])
            self.assertEqual([r['score'] for r in records],[0,1])
            self.assertEqual(sum(r['tokens'] for r in records),40)

    def test_roles_ignore_question_braces_and_keep_braces_in_strings(self):
        role={'name':'Math_Expert','description':'math','tools':[],'suggestions':'check','prompt':'Prove {x} = {y}'}
        text='## Question or Task\nFind {x} in {1,2}.\n## Created Roles List\n'+json.dumps(role)+'\n## Execution Plan\n1. Math_Expert: solve'
        self.assertEqual(parse_roles(text),[role])
        validate_role_plan(text)
        with self.assertRaises(ValueError):validate_role_plan(text+'\n2. [Language Expert]: summarize')
        compound={**role,'name':'Computation and Counting Expert'}
        validate_role_plan('## Created Roles List\n'+json.dumps(compound)+'\n## Execution Plan\n1. [Computation and Counting Expert]: count')

    def test_commented_prompt_definition_repaired_before_execution(self):
        response={'graph':'class Workflow:\n def solve(self): return prompt_custom.SOLVE_PROMPT','prompt':'# SOLVE_PROMPT = """\n# Solve carefully.\n# """','modification':'fixture'}
        fixed=validate_workflow(response)
        namespace={};exec(fixed['prompt'],namespace)
        self.assertIn('Solve carefully.',namespace['SOLVE_PROMPT'])
        with self.assertRaises(ValueError):validate_workflow({**response,'prompt':''})

    def test_pinned_splits_are_disjoint(self):
        search, test = common.tasks('search'), common.tasks('test')
        self.assertEqual((len(search), len(test)), (119, 486))
        self.assertFalse({t['id'] for t in search} & {t['id'] for t in test})

    def test_native_dylan_consensus_stops_after_three_agree(self):
        method = DyLAN()
        with patch('dylan.call', return_value=r'The answer is \boxed{42}.') as call:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(method.solve('Offline fixture'), '42')
        self.assertEqual(call.call_count, 3)

    def test_evoagent_never_reuses_previous_task_answer(self):
        method = EvoAgent()
        method.answer = 'previous task'
        with patch('evoagent.call', side_effect=common.BudgetStop('EPISODE_BUDGET')):
            with self.assertRaises(common.BudgetStop):
                method.solve('new task')
        self.assertEqual(method.final(), '')

    def test_resume_rejects_manifest_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            common.freeze_run(out, 'DyLAN', 'test')
            common.freeze_run(out, 'DyLAN', 'test')
            with patch.dict(os.environ,{'MFLOW_BASELINE_EXECUTION_NAMESPACE':'changed/'}):
                with self.assertRaises(RuntimeError):common.freeze_run(out,'DyLAN','test')
            server=Path(directory)/'server'
            for name in ('baselines/bridge.mjs','configs/automationbench-baselines.json','package-lock.json','benchmark-hub/automation_bridge.py','dist/src/runtime.js'):
                file=server/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('fixture')
            with patch.dict(os.environ,{'MFLOW_BASELINE_TRANSPORT_ROOT':str(server)}):
                shared=Path(directory)/'shared'
                common.freeze_run(shared,'DyLAN','test')
                common.freeze_run(shared,'DyLAN','test')
                (server/'dist/src/runtime.js').write_text('changed')
                with self.assertRaises(RuntimeError):common.freeze_run(shared,'DyLAN','test')
            path = out / 'manifest.json'
            data = json.loads(path.read_text())
            data['model'] = 'different model'
            path.write_text(json.dumps(data))
            with self.assertRaises(RuntimeError):
                common.freeze_run(out, 'DyLAN', 'test')


if __name__ == '__main__':
    unittest.main()
