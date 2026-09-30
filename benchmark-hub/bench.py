#!/usr/bin/env python3
"""Local, model-free benchmark catalog. No agent or model runtime lives here."""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

NAMES = ("drop", "humaneval", "mbpp", "gsm8k", "math", "humaneval_plus", "gaia", "bfcl", "tau3", "hle", "automationbench")
ALIASES = {"humaneval+": "humaneval_plus", "τ³": "tau3", "bfcl_v4": "bfcl"}
AFLOW = json.loads(Path(__file__).with_name("aflow.lock.json").read_text())
PROTOCOL = "aflow-3f457218"
PLUS_PROTOCOL = "humaneval-plus-aflow-v1"


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def name(value):
    value = ALIASES.get(value.lower(), value.lower())
    if value not in NAMES:
        raise ValueError(f"Unknown benchmark: {value}")
    return value


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Path escapes benchmark home: {relative}")
    return path


def verify_aflow(folder):
    for benchmark in NAMES[:5]:
        for split, original in (("search", "validate"), ("test", "test")):
            expected = AFLOW["files"][f"{benchmark}_{original}.jsonl"]["convertedSha256"]
            if sha(folder / benchmark / f"{split}.jsonl") != expected:
                raise ValueError(f"AFlow converted split mismatch: {benchmark}/{split}")
        if (folder / benchmark / "confirmation.jsonl").exists():
            raise ValueError("AFlow has no confirmation split")
    if sha(folder / "raw/aflow_data.tar.gz") != AFLOW["archiveSha256"]:
        raise ValueError("AFlow archive mismatch")


def verify_existing_official(folder):
    archives = {}
    try:
        for relative, entry in read(folder / "checksums.json").items():
            if entry.get("archive"):
                archive = archives.setdefault(entry["archive"], None)
                if archive is None:
                    archive = archives[entry["archive"]] = tarfile.open(folder / entry["archive"], "r:gz")
                member = archive.getmember(entry["member"])
                if member.issym():
                    if member.linkname != entry.get("symlink"):
                        raise ValueError(f"Archived symlink changed: {relative}")
                    continue
                else:
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise ValueError(f"Missing archived member: {relative}")
                    actual = hashlib.sha256(stream.read()).hexdigest()
            else:
                actual = sha(contained(folder, relative))
            if actual != entry["sha256"]:
                raise ValueError(f"Existing source checksum mismatch: {relative}")
    finally:
        for archive in archives.values():
            if archive is not None:
                archive.close()
    for record in read(folder / "sources.json"):
        field = "evaluator_revision" if record["id"] == "humaneval_plus" else "revision"
        directory = {"humaneval_plus": "HumanEval+", "bfcl_v4": "BFCL", "tau3": "tau3"}.get(record["id"])
        if directory:
            actual = subprocess.check_output(["git", "-C", str(folder / directory / "official"), "rev-parse", "HEAD"], text=True).strip()
            if actual != record[field]:
                raise ValueError(f"Official checkout revision mismatch: {directory}")


def relocate(source, target):
    """Same-volume move plus compatibility link; interrupted moves can be resumed."""
    source = source.absolute()
    if source.is_symlink():
        if source.resolve() != target.resolve():
            raise ValueError(f"Source already points elsewhere: {source}")
        return
    if target.exists() and source.exists():
        raise FileExistsError(f"Both source and target exist: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.exists():
        source.rename(target)
    if not target.is_dir():
        raise FileNotFoundError(target)
    source.symlink_to(target, target_is_directory=True)


def plus_rows(raw, human):
    with gzip.open(raw, "rt", encoding="utf-8") as f:
        problems = {r["task_id"]: r for r in map(json.loads, f)}
    result = {}
    seen = set()
    for split in ("search", "test"):
        rows = []
        for line in (human / f"{split}.jsonl").read_text(encoding="utf-8").splitlines():
            original = json.loads(line)
            ident = original["id"].removeprefix("humaneval:")
            if ident in seen:
                raise ValueError("HumanEval family crosses splits")
            seen.add(ident)
            problem = problems[ident]
            # IDs follow AFlow, prompts follow EvalPlus. Oracles/inputs remain grader-only.
            rows.append({"id": f"humaneval_plus:{ident}", "benchmark": "humaneval_plus",
                         "dataset": {"protocol": PLUS_PROTOCOL, "split": split},
                         "group": f"humaneval:{ident}", "prompt": problem["prompt"], "answer": "",
                         "metric": "evalplus", "reference": {"prefix": problem["prompt"],
                         "entryPoint": problem["entry_point"], "evalplusTaskId": ident}})
        result[split] = ("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)).encode("utf-8")
    if seen != set(problems):
        raise ValueError("HumanEval+ task IDs do not exactly match AFlow HumanEval")
    return result


def import_local(root, mflow, official):
    aflow = root / "collections" / PROTOCOL
    upstream = root / "collections/official-20260930"
    verify_aflow(mflow if mflow.exists() else aflow)
    verify_existing_official(official if official.exists() else upstream)
    relocate(mflow, aflow)
    relocate(official, upstream)
    source_records = {r["id"]: r for r in read(upstream / "sources.json")}
    benchmarks = {}
    for benchmark in NAMES[:5]:
        benchmarks[benchmark] = {"defaultProtocol": PROTOCOL, "views": {PROTOCOL: {
            "path": f"collections/{PROTOCOL}/{benchmark}", "format": "mflow-jsonl",
            "searchCount": AFLOW["files"][f"{benchmark}_validate.jsonl"]["count"],
            "testCount": AFLOW["files"][f"{benchmark}_test.jsonl"]["count"],
            "sourceRevision": AFLOW["upstreamCommit"], "runtime": "ready"}}}
    plus = root / "views" / PLUS_PROTOCOL
    raw = upstream / "HumanEval+/HumanEvalPlus-v0.1.10.jsonl.gz"
    data = plus_rows(raw, aflow / "humaneval")
    lock = read(Path(__file__).with_name("humaneval-plus.lock.json"))
    if sha(raw) != lock["sourceSha256"]:
        raise ValueError("HumanEval+ source version changed")
    plus.mkdir(parents=True, exist_ok=True)
    for split, content in data.items():
        if hashlib.sha256(content).hexdigest() != lock["splits"][split]["sha256"]:
            raise ValueError(f"HumanEval+ conversion changed: {split}")
        file = plus / f"{split}.jsonl"
        if file.exists() and file.read_bytes() != content:
            raise ValueError(f"Existing derived data changed: {file}")
        file.write_bytes(content)
    save(plus / "manifest.json", lock)
    benchmarks["humaneval_plus"] = {"defaultProtocol": PLUS_PROTOCOL, "source": source_records["humaneval_plus"],
        "views": {PLUS_PROTOCOL: {"path": "views/" + PLUS_PROTOCOL, "format": "mflow-jsonl",
        "searchCount": 33, "testCount": 131, "runtime": "evalplus-image-required"}},
        "raw": "collections/official-20260930/HumanEval+"}
    for benchmark, original, directory, fmt, scope in (
        ("gaia", "gaia", "GAIA", "parquet+attachments", "2023 validation only; official test not installed"),
        ("bfcl", "bfcl_v4", "BFCL", "official-tool-environment", "V4 official checkout; MFlow adapter pending"),
        ("tau3", "tau3", "tau3", "official-interactive-environment", "v1.0.1 base tasks; MFlow adapter pending"),
    ):
        benchmarks[benchmark] = {"source": source_records[original], "raw": f"collections/official-20260930/{directory}",
                                 "format": fmt, "scope": scope, "runtime": "assets-only"}
    benchmarks["math"]["official"] = {"path": "collections/official-20260930/MATH", "source": source_records["math"]}
    # Keep full original downloads and old protocols explicitly separate from active AFlow views.
    for benchmark, relative in (("drop", "drop.zip"), ("humaneval", "human-eval.jsonl.gz"),
                               ("mbpp", "mbpp.jsonl"), ("gsm8k", "gsm8k-test.jsonl")):
        benchmarks[benchmark]["originalDownload"] = f"collections/{PROTOCOL}/raw/{relative}"
    manifest = {}
    for collection in (aflow, upstream, plus):
        for file in sorted(collection.rglob("*")):
            if file.is_file() and ".git" not in file.parts and "__pycache__" not in file.parts:
                if file.name == ".env":
                    raise ValueError(f"Credentials must not enter benchmark assets: {file}")
                manifest[str(file.relative_to(root))] = {"sha256": sha(file), "bytes": file.stat().st_size}
    if (root / "catalog.json").exists():
        # A rerun must not silently establish a new checksum baseline.
        verify(root)
        manifest = {**read(root / 'manifests/files.json'), **manifest}
        benchmarks = {**read(root / 'catalog.json')['benchmarks'], **benchmarks}
    save(root / "manifests/files.json", manifest)
    save(root / "catalog.json", {"version": 1, "benchmarks": benchmarks,
                                "fileManifest": "manifests/files.json", "mutableState": "state/"})
    return {"benchmarks": list(benchmarks), "files": len(manifest), "bytes": sum(r["bytes"] for r in manifest.values())}


def verify(root, benchmark="all"):
    catalog = read(root / "catalog.json")
    selected = catalog["benchmarks"] if benchmark == "all" else {benchmark: catalog["benchmarks"][benchmark]}
    prefixes = []
    singles = []
    for record in selected.values():
        prefixes.extend(v["path"] + "/" for v in record.get("views", {}).values())
        prefixes.extend(record[k] + "/" for k in ("raw",) if k in record)
        if 'official' in record:
            prefixes.append(record['official']['path'] + '/')
        if 'originalDownload' in record:
            singles.append(record['originalDownload'])
    manifest = read(contained(root, catalog["fileManifest"]))
    checked = 0
    for relative, expected in manifest.items():
        if benchmark != "all" and relative not in singles and not any(relative.startswith(p) for p in prefixes):
            continue
        file = contained(root, relative)
        if sha(file) != expected["sha256"] or file.stat().st_size != expected["bytes"]:
            raise ValueError(f"Shared asset changed: {relative}")
        checked += 1
    if not checked:
        raise ValueError("No assets verified")
    if benchmark in ("all", *NAMES[:5]):
        verify_aflow(root / "collections" / PROTOCOL)
    return {"verifiedFiles": checked, "benchmark": benchmark}


def resolve_path(root, benchmark, protocol=None, split=None):
    record = read(root / "catalog.json")["benchmarks"][benchmark]
    if protocol == "raw":
        relative = record.get('raw') or record.get('originalDownload') or record.get('official', {}).get('path')
        if not relative:
            raise ValueError(f'{benchmark} has no raw asset path')
        return contained(root, relative)
    protocol = protocol or record.get("defaultProtocol")
    if protocol is None:
        if split:
            raise ValueError(f"{benchmark} has no MFlow search/test view; interactive adapter pending")
        return contained(root, record["raw"])
    view = record["views"][protocol]
    path = contained(root, view["path"])
    if split:
        if split not in ("search", "test"):
            raise ValueError("No confirmation split in these locked protocols")
        path /= split + ".jsonl"
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def install(root):
    root.mkdir(parents=True, exist_ok=True)
    for filename in ("bench.py", "aflow.lock.json", "humaneval-plus.lock.json", "README.md", "Dockerfile.evalplus", "prepare_extra.py", "automation_bridge.py"):
        source = Path(__file__).with_name(filename)
        target = root / filename
        if source.resolve() != target.resolve():
            shutil.copy2(source, target)
    (root / ".gitignore").write_text("collections/\nviews/\nstate/\nenvironments/\nmanifest*/\ncatalog.json\n.env\n__pycache__/\n", encoding="utf-8")
    return {"home": str(root), "manager": str(root / "bench.py")}


def main():
    default = os.environ.get("BENCHMARK_HOME") or (Path(__file__).resolve().parents[2] / "Benchmarks"
        if Path(__file__).parent.name == "benchmark-hub" else Path(__file__).parent)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, default=Path(default))
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("install")
    sub.add_parser("list")
    v = sub.add_parser("verify")
    v.add_argument("--name", default="all")
    path = sub.add_parser("path")
    path.add_argument("name")
    path.add_argument("--protocol")
    path.add_argument("--split", choices=("search", "test"))
    migrate = sub.add_parser("import-local")
    migrate.add_argument("--mflow-data", type=Path, required=True)
    migrate.add_argument("--official-data", type=Path, required=True)
    args = p.parse_args()
    root = args.root.resolve()
    if args.command == "install":
        result = install(root)
    elif args.command == "import-local":
        result = import_local(root, args.mflow_data, args.official_data)
    elif args.command == "verify":
        result = verify(root, "all" if args.name == "all" else name(args.name))
    elif args.command == "path":
        print(resolve_path(root, name(args.name), args.protocol, args.split))
        return
    else:
        catalog = read(root / "catalog.json")
        files = read(root / catalog["fileManifest"])
        result = {"home": str(root), "storedBytes": sum(r["bytes"] for r in files.values()), "benchmarks": catalog["benchmarks"]}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
