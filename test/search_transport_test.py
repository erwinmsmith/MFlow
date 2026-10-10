import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from search_transport import request, ControllerFailure, ProviderUnavailable
from evidence_storage import write_evidence
from automation_experiment import stop_process


class RecoveryTest(unittest.TestCase):
    def test_transport_failure_cannot_advance_native_optimizer(self):
        for failure in [urllib.error.URLError(ConnectionRefusedError()), ConnectionResetError(), ValueError('truncated JSON')]:
            with self.subTest(failure=failure), patch('urllib.request.urlopen', side_effect=failure):
                with self.assertRaises(ControllerFailure):
                    try:
                        request('http://127.0.0.1:1', 'evaluate')
                    except Exception:
                        self.fail('The native optimizer would skip this interrupted candidate')

    def test_provider_outage_and_candidate_error_stay_distinct(self):
        for body, expected in [({'unavailable': True}, ProviderUnavailable), ({'fatal': True}, ControllerFailure), ({'error': 'invalid candidate'}, RuntimeError)]:
            failure = urllib.error.HTTPError('url', 500, 'failure', {}, io.BytesIO(json.dumps(body).encode()))
            with patch('urllib.request.urlopen', side_effect=failure), self.assertRaises(expected):
                request('http://127.0.0.1:1', 'propose')

    def test_compressed_evidence_is_readable_and_atomic(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'MFLOW_COMPRESS_EVIDENCE': '1'}):
            p = Path(directory) / 'log.json'
            value = [{'schema': '中文 function schema ' * 10000, 'score': 0, 'arguments': {'a': False}}]
            write_evidence(p, value)
            self.assertEqual(json.loads(p.read_text()), value)
            if sys.platform == 'darwin':
                self.assertLess(p.stat().st_blocks * 512, p.stat().st_size / 2)
                with patch('subprocess.run', side_effect=OSError('compression failed')), self.assertRaises(OSError):
                    write_evidence(p, [{'changed': 'x' * 100000}])
                self.assertEqual(json.loads(p.read_text()), value)
            self.assertEqual([x.name for x in Path(directory).iterdir()], ['log.json'])

    def test_stopping_actor_stops_grandchild(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'alive'
            child_code = "from pathlib import Path; import time; p=Path(" + repr(str(marker)) + ");\nwhile True: p.write_text(str(time.monotonic())); time.sleep(.03)"
            parent_code = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",' + repr(child_code) + ']); time.sleep(60)'
            process = subprocess.Popen([sys.executable, '-c', parent_code], start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline: time.sleep(.02)
                self.assertTrue(marker.exists())
                stop_process(process)
                time.sleep(.1); saved = marker.read_text(); time.sleep(.15)
                self.assertEqual(marker.read_text(), saved)
            finally:
                stop_process(process)


if __name__ == '__main__': unittest.main()
