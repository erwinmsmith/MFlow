import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("hub", Path(__file__).resolve().parents[1] / "benchmark-hub/bench.py")
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class HubTests(unittest.TestCase):
    def test_shared_assets_changed_after_registration_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / "gaia/task.json"
            file.parent.mkdir()
            file.write_text("original")
            hub.save(root / "catalog.json", {"fileManifest": "files.json", "benchmarks": {"gaia": {"raw": "gaia"}}})
            hub.save(root / "files.json", {"gaia/task.json": {"sha256": hub.sha(file), "bytes": file.stat().st_size}})
            self.assertEqual(hub.verify(root, "gaia")["verifiedFiles"], 1)
            file.write_text("changed")
            with self.assertRaisesRegex(ValueError, "Shared asset changed"):
                hub.verify(root, "gaia")

    def test_move_preserves_files_and_old_paths_and_is_resumable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, new = root / "old", root / "shared/new"
            old.mkdir(); (old / "task").write_bytes(b"unchanged")
            before = hub.sha(old / "task")
            hub.relocate(old, new); hub.relocate(old, new)
            self.assertTrue(old.is_symlink())
            self.assertEqual(hub.sha(old / "task"), before)
            self.assertEqual(hub.sha(new / "task"), before)

    def test_path_escape_and_fake_interactive_splits_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hub.save(root / "catalog.json", {"benchmarks": {"gaia": {"raw": "gaia"}}})
            with self.assertRaisesRegex(ValueError, "escapes"):
                hub.contained(root, "../outside")
            with self.assertRaisesRegex(ValueError, "adapter pending"):
                hub.resolve_path(root, "gaia", split="test")
            self.assertEqual(hub.name("HumanEval+"), "humaneval_plus")
            self.assertEqual(hub.name("τ³"), "tau3")


if __name__ == '__main__':
    unittest.main()
