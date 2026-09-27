"""Offline checks. Run with the legacy environment; no model calls are made."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bench_common as common
from dylan import DyLAN
from evoagent import EvoAgent
from repairs import parse_roles, validate_workflow, validate_role_plan


class AdapterTests(unittest.TestCase):
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
