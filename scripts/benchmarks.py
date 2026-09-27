"""Download five public benchmarks and prepare small, disjoint search reservoirs.

Official test/dev sets are retained in full. Labels and tests stay in evaluator records;
MFlow sends only id and prompt to Ditto agents.
"""
import argparse
import gzip
import hashlib
import json
import random
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

SOURCES = {
    "drop": {"drop.zip": "https://s3-us-west-2.amazonaws.com/allennlp/datasets/drop/drop_dataset.zip"},
    "humaneval": {"human-eval.jsonl.gz": "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz"},
    "mbpp": {"mbpp.jsonl": "https://raw.githubusercontent.com/google-research/google-research/master/mbpp/mbpp.jsonl"},
    "gsm8k": {name: f"https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/{split}.jsonl"
              for name, split in (("gsm8k-train.jsonl", "train"), ("gsm8k-test.jsonl", "test"))},
}
MATH_API = "https://huggingface.co/api/datasets/EleutherAI/hendrycks_math/tree/main?recursive=true"
MATH_ROOT = "https://huggingface.co/datasets/EleutherAI/hendrycks_math/resolve/main/"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, path, maximum=20_000_000):
    if path.exists():
        return path.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "MFlow-benchmark-import/1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError(f"Source exceeds {maximum} bytes: {url}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".partial")
    try:
        temp.write_bytes(data)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)
    return data


def lines(data):
    return [json.loads(row) for row in data.decode("utf-8").splitlines() if row.strip()]


def task(name, ident, prompt, answer, metric, **extra):
    return {"id": f"{name}:{ident}", "prompt": prompt, "answer": answer,
            "metric": metric, "benchmark": name, **extra}


def unique(rows, used):
    result = []
    keys = set()
    for row in rows:
        key = " ".join(unicodedata.normalize("NFKC", row["prompt"]).lower().split())
        if key not in used:
            result.append(row)
            keys.add(key)
    used.update(keys)
    return result


def drop_answer(answer):
    if str(answer.get("number", "")):
        return [str(answer["number"])]
    spans = answer.get("spans") or []
    if spans:
        return spans
    date = answer.get("date") or {}
    result = " ".join(str(date.get(k, "")).strip() for k in ("day", "month", "year")).strip()
    return [" ".join(result.split())] if result else []


def drop_rows(data):
    result = []
    seen = set()
    for passage_id, passage in data.items():
        for pair in passage["qa_pairs"]:
            if pair["query_id"] in seen:
                continue
            alternatives = [drop_answer(a) for a in [pair["answer"], *(pair.get("validated_answers") or [])]]
            alternatives = [a for a in alternatives if a]
            if not alternatives:
                continue  # Original DROP contains a few unlabeled questions.
            seen.add(pair["query_id"])
            result.append(task("drop", pair["query_id"],
                               f"Passage:\n{passage['passage']}\n\nQuestion: {pair['question']}\nAnswer briefly. Separate multiple spans with |.",
                               " | ".join(alternatives[0]), "drop", group=f"drop-passage:{passage_id}",
                               reference={"answers": alternatives}))
    return result


def split_train(rows, seed, search_size, confirmation_size):
    groups = {}
    for row in rows:
        groups.setdefault(row.get("group", row["id"]), []).append(row)
    keys = list(groups)
    random.Random(seed).shuffle(keys)
    search, confirmation = [], []
    for key in keys:
        target = search if len(search) < search_size else confirmation
        if len(confirmation) >= confirmation_size:
            break
        target.extend(groups[key])
    if not search or not confirmation:
        raise ValueError("Not enough independent training groups")
    return search, confirmation


def prepare(name, raw, seed, search_size, confirmation_size):
    if name == "drop":
        with zipfile.ZipFile(raw / "drop.zip") as archive:
            train = drop_rows(json.loads(archive.read("drop_dataset/drop_dataset_train.json")))
            test = drop_rows(json.loads(archive.read("drop_dataset/drop_dataset_dev.json")))
    elif name == "gsm8k":
        convert = lambda data, split: [task("gsm8k", f"{split}-{i}",
            row["question"] + "\nReturn only the final number.", row["answer"].rsplit("####", 1)[-1].strip().replace(",", ""),
            "numeric") for i, row in enumerate(lines(data))]
        train = convert((raw / "gsm8k-train.jsonl").read_bytes(), "train")
        test = convert((raw / "gsm8k-test.jsonl").read_bytes(), "test")
    elif name == "mbpp":
        all_rows = [task("mbpp", row["task_id"],
            "Write Python code for this task. Return code only.\n" + row["text"] +
            "\nYour code should pass these tests:\n" + "\n".join(row["test_list"]),
            "", "python", reference={"tests": row["test_list"], "setup": row.get("test_setup_code", "")})
            for row in lines((raw / "mbpp.jsonl").read_bytes())]
        by_id = {int(row["id"].split(":")[1]): row for row in all_rows}
        train = [by_id[i] for i in range(601, 975) if i in by_id]
        validation = [by_id[i] for i in range(511, 601) if i in by_id]
        test = [by_id[i] for i in range(11, 511) if i in by_id]
        search = random.Random(seed).sample(train, min(search_size, len(train)))
        confirmation = random.Random(seed).sample(validation, min(confirmation_size, len(validation)))
        return search, confirmation, test, {"train": len(train), "validation": len(validation), "test": len(test), "prompt_only": 10}
    elif name == "humaneval":
        rows = lines(gzip.decompress((raw / "human-eval.jsonl.gz").read_bytes()))
        test = [task("humaneval", row["task_id"].split("/")[-1],
            "Complete this Python function. Return executable code only, without Markdown.\n" + row["prompt"],
            "", "python", reference={"prefix": row["prompt"], "entryPoint": row["entry_point"],
                                       "tests": [row["test"]]}) for row in rows]
        return [], [], test, {"test": len(test), "search": 0, "confirmation": 0}
    elif name == "math":
        try:
            import pyarrow.parquet as pq
        except ImportError as error:
            raise RuntimeError("MATH conversion needs pyarrow; install benchmark Python requirements") from error
        train, test = [], []
        for file in sorted((raw / "math").glob("*/*.parquet")):
            split = "test" if file.name.startswith("test-") else "train"
            target = test if split == "test" else train
            for i, row in enumerate(pq.read_table(file).to_pylist()):
                target.append(task("math", f"{split}-{file.parent.name}-{i}",
                    row["problem"] + "\nReturn only the final answer; use LaTeX when appropriate.",
                    row["solution"], "math"))
    else:
        raise ValueError(f"Unknown benchmark: {name}")
    search, confirmation = split_train(train, seed, search_size, confirmation_size)
    return search, confirmation, test, {"train": len(train), "test": len(test),
                                        "search": len(search), "confirmation": len(confirmation)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", choices=[*SOURCES, "math", "all"], default="all")
    parser.add_argument("--out", type=Path, default=Path("data/benchmarks"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--search-size", type=int, default=64)
    parser.add_argument("--confirmation-size", type=int, default=16)
    options = parser.parse_args()
    if options.search_size < 1 or options.confirmation_size < 1:
        parser.error("search and confirmation sizes must be positive")
    names = [*SOURCES, "math"] if options.name == "all" else [options.name]
    for name in names:
        folder = options.out / name
        if folder.exists() and any(folder.iterdir()):
            raise FileExistsError(f"Prepared benchmark exists: {folder}")
        sources = dict(SOURCES.get(name, {}))
        if name == "math":
            listing = json.loads(fetch(MATH_API, options.out / "raw" / "math-tree.json", 1_000_000))
            sources = {"math/" + item["path"]: MATH_ROOT + item["path"] for item in listing
                       if item["path"].endswith(".parquet")}
            if len(sources) != 14:
                raise ValueError("MATH source files changed; inspect before importing")
        source_hashes = {file: sha(fetch(url, options.out / "raw" / file)) for file, url in sources.items()}
        search, confirmation, test, source_counts = prepare(name, options.out / "raw",
                                                            options.seed, options.search_size, options.confirmation_size)
        used = set()
        test = unique(test, used)  # Protect the official held-out set first.
        search = unique(search, used)
        confirmation = unique(confirmation, used)
        ids = set()
        for row in [*search, *confirmation, *test]:
            if row["id"] in ids:
                raise ValueError(f"Split overlap: {row['id']}")
            ids.add(row["id"])
        folder.mkdir(parents=True)
        for split, rows in (("search", search), ("confirmation", confirmation), ("test", test)):
            if rows:
                (folder / f"{split}.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
        manifest = {"benchmark": name, "seed": options.seed, "sources": sources,
                    "sha256": source_hashes, "sourceCounts": source_counts,
                    "splits": {part: {"count": len(rows), "sha256": sha("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode())}
                               for part, rows in (("search", search), ("confirmation", confirmation), ("test", test))}}
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        print(f"{name}: search={len(search)}, confirmation={len(confirmation)}, test={len(test)}")


if __name__ == "__main__":
    main()
