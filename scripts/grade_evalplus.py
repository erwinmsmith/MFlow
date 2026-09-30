"""Run inside the isolated grading container; reuse the official EvalPlus oracle/checker."""
import gzip
import json
import sys

from evalplus.eval import PASS, untrusted_check
from evalplus.gen.util import trusted_exec


def main():
    task_id, raw, candidate = sys.argv[1:]
    with gzip.open(raw, "rt", encoding="utf-8") as f:
        problem = next(row for row in map(json.loads, f) if row["task_id"] == task_id)
    solution = open(candidate, encoding="utf-8").read()
    passed = {}
    for group in ("base", "plus"):
        inputs = problem[group + "_input"]
        expected, reference_times = trusted_exec(problem["prompt"] + problem["canonical_solution"],
            inputs, problem["entry_point"], record_time=True)
        status, _ = untrusted_check("humaneval", solution, inputs, problem["entry_point"],
            expected=expected, atol=problem["atol"], ref_time=reference_times)
        passed[group] = status == PASS
    print(json.dumps({"score": int(all(passed.values())), **passed}))


if __name__ == "__main__":
    main()
