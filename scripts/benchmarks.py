"""Import AFlow's pinned validate/test files without resampling or deduplication."""
import argparse
import hashlib
import json
import tarfile
import urllib.request
from pathlib import Path

LOCK = json.loads((Path(__file__).resolve().parents[1] / "data/aflow.lock.json").read_text())
NAMES = ("drop", "humaneval", "mbpp", "gsm8k", "math")
SPLITS = {"search": "validate", "test": "test"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(rows):
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode("utf-8")


def fetch(path):
    if not path.exists():
        request = urllib.request.Request(LOCK["url"], headers={"User-Agent": "MFlow-benchmark-import/2"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(20_000_001)
        if sha(data) != LOCK["archiveSha256"]:
            raise ValueError("AFlow archive changed or download failed; refusing to change the benchmark")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if sha(path.read_bytes()) != LOCK["archiveSha256"]:
        raise ValueError(f"AFlow archive SHA-256 mismatch: {path}")


def convert(name, split, row):
    # Prompts are exactly the inputs passed to graphs by AFlow's benchmark classes.
    ident = row.get("task_id", row.get("id"))
    if name == "math":
        ident = sha(row["problem"].encode())  # AFlow MATH has no source ID.
    result = {"id": f"{name}:{ident}", "benchmark": name, "aflowSplit": split}
    if name == "drop":
        result.update(prompt=row["context"], answer=row["ref_text"], metric="drop",
                      reference={"answers": [[a.strip()] for a in row["ref_text"].split("|") if a.strip()]})
    elif name == "gsm8k":
        result.update(prompt=row["question"], answer=row["answer"], metric="numeric")
    elif name == "math":
        result.update(prompt=row["problem"], answer=row["solution"], metric="math")
    elif name == "humaneval":
        result.update(prompt=row["prompt"], answer="", metric="python",
                      reference={"prefix": row["prompt"], "entryPoint": row["entry_point"], "tests": [row["test"]]})
    elif name == "mbpp":
        result.update(prompt=row["prompt"], answer="", metric="python",
                      reference={"setup": "\n".join(row["test_imports"]), "tests": [row["test"], "check()"]})
    else:
        raise ValueError(f"Unknown benchmark: {name}")
    return result


def prepare(archive, name):
    prepared = {}
    for target, source in SPLITS.items():
        filename = f"{name}_{source}.jsonl"
        expected = LOCK["files"][filename]
        # Read only named members; never extract arbitrary archive paths or public-test pools.
        raw = archive.extractfile(filename).read()
        if sha(raw) != expected["sha256"]:
            raise ValueError(f"Source SHA-256 mismatch: {filename}")
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if len(rows) != expected["count"]:
            raise ValueError(f"Source count mismatch: {filename}")
        tasks = [convert(name, source, row) for row in rows]
        if len({row["id"] for row in tasks}) != len(tasks):
            raise ValueError(f"Duplicate source IDs: {filename}")
        data = encode(tasks)
        if sha(data) != expected["convertedSha256"]:
            raise ValueError(f"Conversion changed: {filename}; review the protocol before updating its lock")
        prepared[target] = data
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", choices=[*NAMES, "all"], default="all")
    parser.add_argument("--out", type=Path, default=Path("data/benchmarks"))
    parser.add_argument("--verify", action="store_true", help="Check existing files against the locked AFlow conversion; offline")
    options = parser.parse_args()
    names = NAMES if options.name == "all" else [options.name]
    if options.verify:
        for name in names:
            folder = options.out / name
            if (folder / "confirmation.jsonl").exists():
                raise ValueError(f"AFlow has no separate confirmation split: {folder}")
            for target, source in SPLITS.items():
                if sha((folder / f"{target}.jsonl").read_bytes()) != LOCK["files"][f"{name}_{source}.jsonl"]["convertedSha256"]:
                    raise ValueError(f"Prepared data differs from AFlow: {name}/{target}.jsonl")
            print(f"{name}: exact AFlow split verification passed")
        return
    for name in names:
        folder = options.out / name
        if folder.exists() and any(folder.iterdir()):
            raise FileExistsError(f"Prepared benchmark exists: {folder}; archive old data first, or use --verify")
    path = options.out / "raw" / "aflow_data.tar.gz"
    fetch(path)
    with tarfile.open(path, "r:gz") as archive:
        for name in names:
            prepared = prepare(archive, name)
            folder = options.out / name
            folder.mkdir(parents=True, exist_ok=True)
            manifest = {"benchmark": name, "protocol": LOCK["protocol"],
                        "upstreamCommit": LOCK["upstreamCommit"], "source": LOCK["url"],
                        "archiveSha256": LOCK["archiveSha256"], "splits": {},
                        "knownPromptOverlaps": LOCK["knownPromptOverlaps"] if name == "drop" else []}
            for target, data in prepared.items():
                source = f"{name}_{SPLITS[target]}.jsonl"
                (folder / f"{target}.jsonl").write_bytes(data)
                manifest["splits"][target] = {"sourceFile": source, **LOCK["files"][source]}
            (folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            print(f"{name}: search={manifest['splits']['search']['count']}, test={manifest['splits']['test']['count']}, confirmation=none")


if __name__ == "__main__":
    main()
