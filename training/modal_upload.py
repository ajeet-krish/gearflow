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

Nothing here runs a remote job and nothing touches the volume on import or
on dry run. The modal package is imported lazily only on the real upload
path, so the local pytest suite never touches Modal or the network.
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


def build_upload_plan(
    repo_root: Path,
    sweep_id: str,
    include_analytic: bool = True,
    include_sweep: bool = True,
) -> dict:
    """Validate local layout and build the volume upload plan.

    Returns a dict with entries (local_path, remote_path, kind, bytes),
    errors, counts, and total_bytes. On any validation error entries is
    empty: there is never a partial plan.
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
                elif not (case_dir / "umean.f32").is_file():
                    errors.append(f"sweep case bin missing: {case_dir / 'umean.f32'}")

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
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    plan = build_upload_plan(
        Path.cwd(),
        args.sweep_id,
        include_analytic=not args.skip_analytic,
        include_sweep=not args.skip_sweep,
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
