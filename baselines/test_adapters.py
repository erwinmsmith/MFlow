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


class AdapterTests(unittest.TestCase):
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
