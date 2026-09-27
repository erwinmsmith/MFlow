"""One-shot MATH equivalence check; input is a JSON object in argv[1]."""
import json
import re
import sys

from math_verify import parse, verify

record = json.loads(sys.argv[1])
try:
    gold = parse(record["gold"])
    text = record["answer"].strip()
    # Agent answers may be bare LaTeX; the extractor expects math delimiters.
    if "\\" in text and not any(marker in text for marker in ("$", r"\(", r"\[", r"\boxed")):
        text = "$" + text + "$"
    # Plain word/option answers need the same text wrapper as textual MATH gold.
    if re.fullmatch(r"[A-Za-z][A-Za-z ]*", text) and re.search(r"\\boxed\{\\text\{[A-Za-z ]+\}\}", record["gold"]):
        text = r"\boxed{\text{" + text + "}}"
    answer = parse(text)
    print("1" if gold and answer and verify(gold, answer) else "0")
except (ValueError, TypeError, SyntaxError):
    print("0")
