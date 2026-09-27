import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("benchmarks", Path(__file__).resolve().parents[1] / "scripts/benchmarks.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class ConversionTests(unittest.TestCase):
    def test_mbpp_keeps_hidden_tests_out_of_prompt(self):
        row = {"task_id": 1, "prompt": "def f(x):", "code": "SECRET SOLUTION",
               "test": "def check():\n    assert f(1) == 2", "test_imports": ["import math"]}
        converted = b.convert("mbpp", "test", row)
        self.assertEqual(converted["prompt"], row["prompt"])
        self.assertEqual(converted["reference"]["tests"], [row["test"], "check()"])
        self.assertEqual(converted["aflowSplit"], "test")
        self.assertNotIn("SECRET SOLUTION", str(converted))

    def test_drop_pipe_is_alternatives(self):
        row = {"id": 1, "context": "Passage: text\nQuestion: q\nAnswer:", "ref_text": "A|B", "completion": "secret"}
        converted = b.convert("drop", "validate", row)
        self.assertEqual(converted["prompt"], row["context"])
        self.assertEqual(converted["reference"]["answers"], [["A"], ["B"]])
        self.assertNotIn("group", converted)  # Source splits are by question, not passage.

    def test_math_identity_independent_of_split_or_position(self):
        row = {"problem": "2+2?", "solution": "4"}
        self.assertEqual(b.convert("math", "validate", row)["id"], b.convert("math", "test", row)["id"])


if __name__ == "__main__":
    unittest.main()
