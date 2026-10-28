"""User run uploader for Modal training volumes (gearflow-data).

Run by the user only, never by agents. Modal auth lives in the user local
Modal profile, no secret is read from the repo and no credential material
enters code or logs. Single run command from the repo root:

    python training/modal_upload.py --sweep-id <sweep_id> [--dry-run]

Local layout uploaded to the gearflow-data volume:

    data/manifest.jsonl -> analytic/manifest.jsonl
    data/train/ -> analytic/train/
    data/lbm/<sweep_id>/manifest.jsonl -> lbm/<sweep_id>/manifest.jsonl
    data/lbm/<sweep_id>/cases/ -> lbm/<sweep_id>/cases/

LBM only mode for the post merge and gate upload (paid compute guard):

    python training/modal_upload.py --sweep-id <sweep_id> --only lbm [--dry-run]

LBM only mode uploads just data/lbm/<sweep_id>/manifest.jsonl plus
data/lbm/<sweep_id>/cases/, requires data/lbm/<sweep_id>/merge_report.json
to show status ok, and validates every completed row bins plus sha with
the merge_sweep verifier (schema ordered bins per sha_version). Dry run
lists the merged manifest plus cases and touches no volume.

Nothing here runs a remote job and nothing touches the volume on import or
on dry run. The modal package is imported lazily only on the real upload
path, so the local pytest suite never touches Modal or the network.
Stdlib only plus the local merge_sweep verifier plus lazy Modal import.
"""

import argparse
import json
import sys
from pathlib import Path

DATA_VOLUME_NAME = "gearflow-data"
ANALYTIC_MANIFEST_REMOTE = "analytic/manifest.jsonl"
ANALYTIC_TRAIN_REMOTE = "analytic/train"


def _file_bytes(path: Path) -> int:
    return path.stat().st_size


def _dir_bytes(root: Path) -> int:
    total = 0
    for child in root.rglob("*"):
        if child.is_file():
            total += child.stat().st_size
    return total


def _read_lines(path: Path) -> list[str]:
    return [line for line in path.read_text().splitlines() if line.strip()]


def _validate_merge_report_ok(sweep_dir: Path) -> str | None:
    """Require the merge report for a merged sweep to show status ok."""
    report_path = sweep_dir / "merge_report.json"
    if not report_path.is_file():
        return f"merge report missing: {report_path}"
    try:
        report = json.loads(report_path.read_text())
    except (OSError, ValueError) as exc:
        return f"merge report unreadable: {report_path}: {exc}"
    if not isinstance(report, dict) or report.get("status") != "ok":
        return f"merge report not ok: {report_path}"
    return None


def _sweep_case_problem(case_dir: Path, row: dict) -> str | None:
    """Validate one completed sweep case with the merge_sweep verifier.

    Reuses merge_sweep.verify_completed (schema ordered bins per
    sha_version, sizes, finiteness, sha agreement) so the upload check
    cannot drift from the merge check. Stdlib only, no network.
    """
    import sys

    training_dir = Path(__file__).resolve().parent
    if str(training_dir) not in sys.path:
        sys.path.insert(0, str(training_dir))
    from merge_sweep import verify_completed

    return verify_completed(case_dir, row)


def build_upload_plan(
    repo_root: Path,
    sweep_id: str,
    include_analytic: bool = True,
    include_sweep: bool = True,
    require_merge_ok: bool = False,
) -> dict:
    """Validate local layout and build the volume upload plan.

    Returns a dict with entries (local_path, remote_path, kind, bytes),
    errors, counts, and total_bytes. On any validation error entries is
    empty: there is never a partial plan. When require_merge_ok is true
    (the LBM only post merge path) the sweep merge_report.json must show
    status ok and every completed case is checked with the merge_sweep
    verifier (all schema bins plus sha agreement per sha_version).
    """
    repo_root = Path(repo_root)
    errors: list[str] = []
    analytic_rows = 0
    sweep_completed = 0
    staged: list[dict] = []

    if not include_analytic and not include_sweep:
        errors.append("nothing to upload: analytic and sweep both skipped")
        return {
            "entries": [],
            "errors": errors,
            "counts": {"entries": 0, "analytic_rows": 0, "sweep_completed": 0, "total_bytes": 0},
            "total_bytes": 0,
        }

    analytic_manifest = repo_root / "data" / "manifest.jsonl"
    analytic_train = repo_root / "data" / "train"
    analytic_shards: list[Path] = []
    if include_analytic:
        if not analytic_manifest.is_file():
            errors.append(f"analytic manifest missing: {analytic_manifest}")
        else:
            try:
                analytic_rows = len(_read_lines(analytic_manifest))
            except OSError as exc:
                errors.append(f"analytic manifest unreadable: {analytic_manifest}: {exc}")
            if analytic_rows == 0 and not any("analytic manifest" in e for e in errors):
                errors.append(f"analytic manifest holds no rows: {analytic_manifest}")
        if not analytic_train.is_dir():
            errors.append(f"analytic train dir missing: {analytic_train}")
        else:
            analytic_shards = sorted(p for p in analytic_train.glob("shard-*.npz") if p.is_file())
            if not analytic_shards:
                errors.append(f"analytic train holds no shard-*.npz: {analytic_train}")

    sweep_dir = repo_root / "data" / "lbm" / sweep_id
    sweep_manifest = sweep_dir / "manifest.jsonl"
    sweep_cases = sweep_dir / "cases"
    sweep_rows: list[dict] | None = None
    if include_sweep:
        if require_merge_ok:
            report_problem = _validate_merge_report_ok(sweep_dir)
            if report_problem is not None:
                errors.append(report_problem)
        if not sweep_manifest.is_file():
            errors.append(f"sweep manifest missing: {sweep_manifest}")
        else:
            try:
                lines = _read_lines(sweep_manifest)
            except OSError as exc:
                lines = []
                errors.append(f"sweep manifest unreadable: {sweep_manifest}: {exc}")
                sweep_rows = None
            if sweep_rows is None and not any("sweep manifest" in e for e in errors):
                sweep_rows = []
                for line in lines:
                    try:
                        sweep_rows.append(json.loads(line))
                    except ValueError as exc:
                        errors.append(f"sweep manifest has bad row: {exc}")
                        sweep_rows = None
                        break
            if sweep_rows is not None:
                completed = [r for r in sweep_rows if r.get("status", "completed") == "completed"]
                sweep_completed = len(completed)
                if not completed:
                    errors.append(f"sweep manifest holds zero completed rows: {sweep_manifest}")
        if not sweep_cases.is_dir():
            errors.append(f"sweep cases dir missing: {sweep_cases}")
        elif sweep_rows is not None:
            for row in sweep_rows:
                if row.get("status", "completed") != "completed":
                    continue
                case_id = str(row.get("case_id", ""))
                if not case_id:
                    errors.append(f"sweep row without case_id: {sweep_manifest}")
                    continue
                case_dir = sweep_cases / case_id
                if not case_dir.is_dir():
                    errors.append(f"sweep case dir missing: {case_dir}")
                    continue
                problem = _sweep_case_problem(case_dir, row)
                if problem is not None:
                    errors.append(f"sweep case {case_id}: {problem}")

    if errors:
        return {
            "entries": [],
            "errors": errors,
            "counts": {"entries": 0, "analytic_rows": 0, "sweep_completed": 0, "total_bytes": 0},
            "total_bytes": 0,
        }

    if include_analytic:
        staged.append(
            {
                "local_path": str(analytic_manifest),
                "remote_path": ANALYTIC_MANIFEST_REMOTE,
                "kind": "file",
                "bytes": _file_bytes(analytic_manifest),
            }
        )
        staged.append(
            {
                "local_path": str(analytic_train),
                "remote_path": ANALYTIC_TRAIN_REMOTE,
                "kind": "dir",
                "bytes": _dir_bytes(analytic_train),
            }
        )
    if include_sweep:
        staged.append(
            {
                "local_path": str(sweep_manifest),
                "remote_path": f"lbm/{sweep_id}/manifest.jsonl",
                "kind": "file",
                "bytes": _file_bytes(sweep_manifest),
            }
        )
        staged.append(
            {
                "local_path": str(sweep_cases),
                "remote_path": f"lbm/{sweep_id}/cases",
                "kind": "dir",
                "bytes": _dir_bytes(sweep_cases),
            }
        )
    total = sum(entry["bytes"] for entry in staged)
    return {
        "entries": staged,
        "errors": [],
        "counts": {
            "entries": len(staged),
            "analytic_rows": analytic_rows if include_analytic else 0,
            "sweep_completed": sweep_completed if include_sweep else 0,
            "total_bytes": total,
        },
        "total_bytes": total,
    }


def print_plan(plan: dict) -> None:
    for entry in plan["entries"]:
        print(
            f"upload plan: {entry['kind']} "
            f"local={entry['local_path']} "
            f"remote={entry['remote_path']} "
            f"bytes={entry['bytes']}"
        )
    print(f"upload total: entries={len(plan['entries'])} bytes={plan['total_bytes']}")


def upload_entries(entries: list[dict], force: bool, volume: object) -> None:
    """Run a single batch_upload for every plan entry."""
    with volume.batch_upload(force=force) as batch:  # type: ignore[attr-defined]
        for entry in entries:
            if entry["kind"] == "file":
                batch.put_file(entry["local_path"], entry["remote_path"])
            else:
                batch.put_directory(entry["local_path"], entry["remote_path"])


def _load_volume() -> object:
    import modal

    return modal.Volume.from_name(DATA_VOLUME_NAME, create_if_missing=False)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Upload local data to the gearflow-data Modal volume.")
    parser.add_argument("--sweep-id", default="pilot")
    parser.add_argument("--skip-analytic", action="store_true")
    parser.add_argument("--skip-sweep", action="store_true")
    parser.add_argument("--only", default=None, choices=["analytic", "sweep", "lbm"])
    parser.add_argument("--kind", default="standard", choices=["standard", "lbm"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    lbm_only = args.only == "lbm" or args.kind == "lbm"
    if args.only == "analytic":
        include_analytic, include_sweep, require_merge_ok = True, False, False
    elif args.only == "sweep":
        include_analytic, include_sweep, require_merge_ok = False, True, False
    elif lbm_only:
        include_analytic, include_sweep, require_merge_ok = False, True, True
    else:
        include_analytic, include_sweep, require_merge_ok = (
            not args.skip_analytic,
            not args.skip_sweep,
            False,
        )

    plan = build_upload_plan(
        Path.cwd(),
        args.sweep_id,
        include_analytic=include_analytic,
        include_sweep=include_sweep,
        require_merge_ok=require_merge_ok,
    )
    print_plan(plan)
    if plan["errors"]:
        for err in plan["errors"]:
            print(f"upload: {err}", file=sys.stderr)
        return 2
    if args.dry_run:
        print("upload: dry run, volume untouched")
        return 0
    volume = _load_volume()
    upload_entries(plan["entries"], args.force, volume)
    print(f"upload: done entries={len(plan['entries'])} bytes={plan['total_bytes']} force={args.force}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
