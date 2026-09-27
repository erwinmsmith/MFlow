"""Offline checks. Run with the legacy environment; no model calls are made."""
import contextlib
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
from repairs import parse_roles, validate_workflow, validate_role_plan


class AdapterTests(unittest.TestCase):
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
            path = out / 'manifest.json'
            data = json.loads(path.read_text())
            data['model'] = 'different model'
            path.write_text(json.dumps(data))
            with self.assertRaises(RuntimeError):
                common.freeze_run(out, 'DyLAN', 'test')


if __name__ == '__main__':
    unittest.main()
