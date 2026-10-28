"""Local merge for Modal sweep worker outputs. No Modal, no network.

Reads CaseSpecV1 rows from the sweep spec plus one fragment.jsonl row per
worker dir, verifies every completed case (sizes, finiteness, sha over the
schema ordered bins per sha_version), then writes data/lbm/<sweep_id>/
with cases plus manifest.jsonl (spec order) plus merge_report.json.

Layouts accepted per worker <case_id> dir: fragment.jsonl plus a nested
case/ dir with bins, or bins directly beside fragment.jsonl (fallback).

Fail closed: on any missing id, sha or size mismatch, non-finite value,
or conflicting duplicate rows, no manifest and no cases are written. Only
merge_report.json is written and the process exits 2. Diverged and setup
error rows are preserved verbatim. Substitute rows (substitutes_for set)
gain substitute true in the merged manifest, originals untouched.

Usage:
    python training/merge_sweep.py <sweep_id> [--workers DIR] [--out DIR]
"""

import argparse
import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

BIN_ORDER_V1 = [
    "umean.f32",
    "vmean.f32",
    "pmean.f32",
    "omegamean.f32",
    "tke.f32",
    "recirc.f32",
    "obstacle.f32",
]
BIN_ORDER_V2 = BIN_ORDER_V1 + ["sdf.f32"]


def bin_order_for(version: int) -> list[str]:
    if int(version) >= 2:
        return list(BIN_ORDER_V2)
    return list(BIN_ORDER_V1)


def recompute_sha(case_dir: Path, version: int) -> str:
    hasher = hashlib.sha256()
    for name in bin_order_for(version):
        hasher.update((case_dir / name).read_bytes())
    return hasher.hexdigest()


def find_case_dir(worker: Path, case_id: str) -> Path | None:
    candidates = [worker / "case", worker / case_id, worker]
    for candidate in candidates:
        if (candidate / "umean.f32").is_file():
            return candidate
    return None


def read_fragment_rows(worker: Path) -> list[dict]:
    for name in ("fragment.jsonl", "manifest.jsonl", "row.jsonl"):
        path = worker / name
        if not path.is_file():
            continue
        rows = []
        for line in path.read_text().splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
        if rows:
            return rows
    return []


def read_fragment_row(worker: Path) -> dict | None:
    rows = read_fragment_rows(worker)
    return rows[0] if rows else None


def check_bins_finite(blob: bytes) -> bool:
    count = len(blob) // 4
    try:
        vals = struct.unpack(f"<{count}f", blob)
    except struct.error:
        return False
    for val in vals:
        if val != val or val in (float("inf"), float("-inf")):
            return False
    return True


def verify_completed(case_dir: Path, row: dict) -> str | None:
    try:
        nx = int(row["nx"])
        ny = int(row["ny"])
        version = int(row.get("sha_version", 1))
    except (KeyError, ValueError, TypeError):
        return "row missing nx, ny, or sha_version"
    expect = nx * ny * 4
    for name in bin_order_for(version):
        blob_path = case_dir / name
        if not blob_path.is_file():
            return f"missing bin {name}"
        try:
            blob = blob_path.read_bytes()
        except OSError as exc:
            return f"unreadable bin {name}: {exc}"
        if len(blob) != expect:
            return f"size mismatch {name}: {len(blob)} != {expect}"
        if not check_bins_finite(blob):
            return f"non-finite values in {name}"
    actual = recompute_sha(case_dir, version)
    if actual != row.get("sha256"):
        return "sha256 mismatch"
    return None


def _remove_failed_outputs(out_dir: Path) -> None:
    """Remove stale merge outputs after a failed merge.

    A failed merge must never leave a manifest.jsonl or cases behind that a
    reader could mistake for a good merge. Only merge_report.json survives.
    """
    manifest = out_dir / "manifest.jsonl"
    if manifest.is_file() or manifest.is_symlink():
        manifest.unlink()
    cases = out_dir / "cases"
    if cases.is_dir() and not cases.is_symlink():
        shutil.rmtree(cases)
    elif cases.is_symlink():
        cases.unlink()


def merge_sweep(spec_path: Path, workers_root: Path, out_dir: Path) -> dict:
    spec_rows: list[dict] = []
    with open(spec_path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                spec_rows.append(json.loads(line))
    if not spec_rows:
        raise ValueError(f"spec holds no cases: {spec_path}")
    order = [str(row["case_id"]) for row in spec_rows]
    if len(set(order)) != len(order):
        raise ValueError("spec holds duplicate case ids")

    seen_rows: dict[str, str] = {}
    merged: list[dict] = []
    errors: list[str] = []
    counts = {"total": len(order), "completed": 0, "diverged": 0, "setup_error": 0, "substituted": 0}

    staged: list[tuple[str, Path, dict]] = []
    for case_id in order:
        worker = workers_root / case_id
        if not worker.is_dir():
            errors.append(f"missing worker for {case_id}")
            continue
        frag_rows = read_fragment_rows(worker)
        if not frag_rows:
            errors.append(f"missing fragment for {case_id}")
            continue
        row = frag_rows[0]
        for extra in frag_rows[1:]:
            if json.dumps(extra, sort_keys=True) != json.dumps(row, sort_keys=True):
                row = None
                break
        if row is None:
            errors.append(f"conflict for {case_id}: duplicate rows differ")
            continue
        if str(row.get("case_id")) != case_id:
            errors.append(f"id mismatch for {case_id}: fragment says {row.get('case_id')!r}")
            continue
        canonical = json.dumps(row, sort_keys=True)
        if case_id in seen_rows:
            if seen_rows[case_id] != canonical:
                errors.append(f"conflict for {case_id}: duplicate rows differ")
            continue
        seen_rows[case_id] = canonical
        status = row.get("status")
        if status == "completed":
            case_dir = find_case_dir(worker, case_id)
            if case_dir is None:
                errors.append(f"missing case dir for {case_id}")
                continue
            problem = verify_completed(case_dir, row)
            if problem is not None:
                errors.append(f"{case_id}: {problem}")
                continue
            out_row = dict(row)
            if out_row.get("substitutes_for") is not None:
                out_row["substitute"] = True
                counts["substituted"] += 1
            merged.append(out_row)
            staged.append((case_id, case_dir, out_row))
            counts["completed"] += 1
        elif status == "diverged":
            merged.append(dict(row))
            counts["diverged"] += 1
        elif status == "setup_error":
            merged.append(dict(row))
            counts["setup_error"] += 1
        else:
            errors.append(f"{case_id}: unknown status {status!r}")

    report: dict = {
        "spec": str(spec_path),
        "workers": str(workers_root),
        "out": str(out_dir),
        "counts": counts,
        "errors": errors,
    }
    if errors:
        report["status"] = "failed"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "merge_report.json").write_text(json.dumps(report, indent=2) + "\n")
        _remove_failed_outputs(out_dir)
        return report

    staging = out_dir.parent / (out_dir.name + ".staging")
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "cases").mkdir(parents=True, exist_ok=True)
    for case_id, case_dir, _row in staged:
        target = staging / "cases" / case_id
        shutil.copytree(case_dir, target)
    with open(staging / "manifest.jsonl", "w") as handle:
        for row in merged:
            handle.write(json.dumps(row) + "\n")
    report["status"] = "ok"
    (staging / "merge_report.json").write_text(json.dumps(report, indent=2) + "\n")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    staging.rename(out_dir)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Merge Modal sweep workers locally.")
    parser.add_argument("sweep_id")
    parser.add_argument("--workers", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--spec", default=None)
    args = parser.parse_args(argv)
    spec_path = Path(args.spec) if args.spec else Path("data/sweep") / args.sweep_id / "cases.jsonl"
    workers_root = Path(args.workers) if args.workers else Path("data/sweep") / args.sweep_id / "workers"
    out_dir = Path(args.out) if args.out else Path("data/lbm") / args.sweep_id
    if not spec_path.is_file():
        print(f"merge: spec not found: {spec_path}", file=sys.stderr)
        return 2
    try:
        report = merge_sweep(spec_path, workers_root, out_dir)
    except (ValueError, OSError) as exc:
        out_dir.mkdir(parents=True, exist_ok=True)
        fallback = {"status": "failed", "errors": [str(exc)], "counts": {}}
        (out_dir / "merge_report.json").write_text(json.dumps(fallback, indent=2) + "\n")
        _remove_failed_outputs(out_dir)
        print(f"merge: {exc}", file=sys.stderr)
        return 2
    if report.get("status") != "ok":
        for err in report.get("errors", []):
            print(f"merge: {err}", file=sys.stderr)
        return 2
    counts = report.get("counts", {})
    print(f"merge: ok total={counts.get('total')} completed={counts.get('completed')} diverged={counts.get('diverged')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
