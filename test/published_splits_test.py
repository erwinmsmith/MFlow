"""Model-free contract tests for the public split package."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('published_splits', ROOT / 'benchmark-splits/splits.py')
splits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(splits)


class PublishedSplits(unittest.TestCase):
    def test_every_protocol_has_locked_membership_and_metadata(self):
        catalog = splits.read(ROOT / 'benchmark-splits/catalog.json')
        self.assertEqual(len(catalog['entries']), 11)
        for entry in catalog['entries']:
            m, ids, metadata = splits.load(entry['benchmark'], entry['protocol'])
            self.assertTrue(ids)
            self.assertEqual(splits.sha((ROOT / m['upstreamLock']).read_bytes()), m['upstreamLockSha256'])
            self.assertFalse(set(ids.get('search', [])) & set(ids.get('test', [])))
            for records in metadata.values():
                for row in records.values():
                    self.assertFalse({'prompt', 'answer', 'reference', 'solution'} & set(row))
        self.assertEqual(splits.load('bfcl')[0]['splits']['test']['count'], 600)
        self.assertEqual(len(splits.load('drop')[0]['knownPromptOverlaps']), 5)
        with self.assertRaises(ValueError):
            splits.load('hle')

    def test_content_or_order_changes_fail_but_json_formatting_does_not(self):
        rows = [{'id': 'task:1', 'prompt': 'Public', 'answer': 'Private'}, {'id': 'task:2', 'prompt': 'Other', 'answer': 'Reference'}]
        ids = {'test': [r['id'] for r in rows]}
        metadata = {'test': {r['id']: {'recordSha256': splits.sha(splits.canonical(r))} for r in rows}}
        manifest = {'benchmark': 'fixture', 'protocol': 'fixture-v1', 'knownPromptOverlaps': [], 'splits': {'test': {'recordsSha256': splits.sha(splits.canonical(rows))}}}
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            file = p / 'test.jsonl'
            file.write_text('\n'.join(json.dumps(r, separators=(',', ':')) for r in rows))
            self.assertEqual(splits.verify(manifest, ids, metadata, p)['verified'], {'test': 2})
            file.write_text('\n'.join(json.dumps(r) for r in rows[::-1]))
            with self.assertRaisesRegex(ValueError, 'order'):
                splits.verify(manifest, ids, metadata, p)
            rows[0]['answer'] = 'Changed'
            file.write_text('\n'.join(json.dumps(r) for r in rows))
            with self.assertRaisesRegex(ValueError, 'content'):
                splits.verify(manifest, ids, metadata, p)

    def test_tampered_manifest_is_rejected(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            shutil.copytree(ROOT / 'benchmark-splits', p / 'splits')
            file = p / 'splits/bfcl/bfcl-multiturn-family-v1/manifest.json'
            file.write_text(file.read_text() + ' ')
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                splits.load('bfcl', root=p / 'splits')


if __name__ == '__main__':
    unittest.main()
