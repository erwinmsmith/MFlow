"""One-shot MATH equivalence check; input is a JSON object on stdin."""
import json
import sys

from math_verify import parse, verify

record = json.loads(sys.argv[1])
try:
    gold = parse(record["gold"])
    answer = parse(record["answer"])
    print("1" if gold and answer and verify(gold, answer) else "0")
except (ValueError, TypeError, SyntaxError):
    print("0")
