"""Modal CPU sweep for the Rust dataset_pilot runner (gearflow-lbm-sweep).

Run by the user only, never by agents. Modal auth lives in the user local
Modal profile, no secret is read from the repo. Single run command from the
repo root:

    modal run training/modal_sweep.py --sweep-id <sweep_id>

Inputs are read from data/sweep/<sweep_id>/cases.jsonl (CaseSpecV1 JSON
lines). Each case runs on its own container (max 16) with 4 vCPU and
4096 MiB, timeout 1800 s, retries 2 for infrastructure loss only. Worker
layout on the gearflow-sweep volume at /sweep:

    /sweep/runs/<sweep_id>/workers/<case_id>/fragment.jsonl
    /sweep/runs/<sweep_id>/workers/<case_id>/case/ (bins plus meta.json)

Completed outputs already verified on the volume count as cached and are
skipped unless force is true. A diverged run is a successful outcome: no
retry, no auto substitute. Merge happens locally afterwards with
training/merge_sweep.py, never on Modal. Zero Modal spend happens until
the user runs this file.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import modal

app = modal.App("gearflow-lbm-sweep")

RUST_TOOLCHAIN = "1.85.0"
BINARY_PATH = "/root/gearflow-wasm/target/release/dataset_pilot"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("build-essential", "curl")
    .run_commands(
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | "
        f"sh -s -- -y --profile minimal --default-toolchain {RUST_TOOLCHAIN}",
        f"$HOME/.cargo/bin/rustup toolchain install {RUST_TOOLCHAIN} --profile minimal",
    )
    .add_local_dir("rust/gearflow-wasm", "/root/gearflow-wasm", copy=True)
    .add_local_file("training/merge_sweep.py", "/root/training/merge_sweep.py", copy=True)
    .run_commands(
        "$HOME/.cargo/bin/cargo build --locked --release "
        "--manifest-path /root/gearflow-wasm/Cargo.toml --bin dataset_pilot",
        f"test -x {BINARY_PATH}",
    )
)

sweep_volume = modal.Volume.from_name("gearflow-sweep", create_if_missing=True)
SWEEP_MOUNT = "/sweep"


def _worker_dir(sweep_id: str, case_id: str) -> Path:
    return Path(SWEEP_MOUNT) / "runs" / sweep_id / "workers" / case_id


def _verify_cached_bins(case_dir: Path, row: dict) -> bool:
    """Best effort cache check on the worker: sizes and sha match.

    Bin order is the canonical merge_sweep schema order per sha_version
    (1, 2, or 3); sha_version is required explicitly on the row so a v3
    case with 12 bins is recognised as cached. No local bin list lives
    here: names always come from merge_sweep.bin_order_for.
    """
    try:
        import hashlib
        import struct
        import sys

        if "/root/training" not in sys.path:
            sys.path.insert(0, "/root/training")
        from merge_sweep import bin_order_for

        nx = int(row["nx"])
        ny = int(row["ny"])
        if row.get("sha_version") is None:
            return False
        version = int(row["sha_version"])
        names = bin_order_for(version)
        expect = nx * ny * 4
        hasher = hashlib.sha256()
        for name in names:
            blob = (case_dir / name).read_bytes()
            if len(blob) != expect:
                return False
            hasher.update(blob)
            count = len(blob) // 4
            vals = struct.unpack(f"<{count}f", blob)
            for val in vals:
                if val != val or val in (float("inf"), float("-inf")):
                    return False
        return hasher.hexdigest() == row.get("sha256")
    except (OSError, ValueError, KeyError, struct.error):
        return False


@app.function(
    image=image,
    volumes={SWEEP_MOUNT: sweep_volume},
    cpu=4,
    memory=4096,
    timeout=1800,
    # Retry semantics: retries=2 covers transient infrastructure loss only
    # (container preemption, volume mount blips). Diverged and setup_error
    # rows are non error outcomes: the worker returns them as data, never
    # raises, so they never retry. Genuine application errors raise
    # RuntimeError and fail the case; Modal has no per exception retry
    # filter here, so the comment is the contract: infra loss may retry,
    # app errors must surface in the fragment row, not silently repeat.
    retries=2,
    max_containers=16,
)
def run_case_remote(payload: dict) -> dict:
    """Run one spec case with the prebuilt dataset_pilot binary."""
    case = payload["case"]
    sweep_id = payload["sweep_id"]
    force = bool(payload.get("force", False))
    case_id = str(case["case_id"])

    if not os.path.isfile(BINARY_PATH):
        raise RuntimeError(f"dataset_pilot binary missing at {BINARY_PATH}")

    worker = _worker_dir(sweep_id, case_id)
    case_dir = worker / "case"
    fragment = worker / "fragment.jsonl"
    if not force and fragment.is_file() and case_dir.is_dir():
        try:
            row = json.loads(fragment.read_text().splitlines()[0])
            if row.get("case_id") == case_id and row.get("status") in ("completed", "diverged", "setup_error"):
                if row.get("status") != "completed" or _verify_cached_bins(case_dir, row):
                    return {"case_id": case_id, "status": row.get("status"), "cached": True}
        except (OSError, ValueError, IndexError):
            pass

    worker.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as spec_file:
        spec_file.write(json.dumps(case) + "\n")
        spec_path = spec_file.name
    try:
        proc = subprocess.run(
            [BINARY_PATH, "cases", spec_path, "out", str(worker), "manifest_out", str(fragment), "only", case_id],
            capture_output=True,
            text=True,
            timeout=1700,
        )
    finally:
        try:
            os.unlink(spec_path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(f"dataset_pilot failed for {case_id}: {proc.stderr[-2000:]}")

    nested = worker / case_id
    if nested.is_dir() and not case_dir.is_dir():
        nested.rename(case_dir)
    row = json.loads(fragment.read_text().splitlines()[0])
    return {"case_id": case_id, "status": row.get("status"), "cached": False}


@app.local_entrypoint()
def main(sweep_id: str, force: bool = False) -> None:
    """Fan out one container per case id, capped at 16 containers."""
    spec_path = Path("data/sweep") / sweep_id / "cases.jsonl"
    if not spec_path.is_file():
        raise FileNotFoundError(f"spec not found: {spec_path}")
    cases = []
    with open(spec_path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    if not cases:
        raise ValueError(f"spec holds no cases: {spec_path}")
    seen = set()
    for case in cases:
        case_id = case.get("case_id")
        if case_id in seen:
            raise ValueError(f"duplicate case_id {case_id!r} in {spec_path}")
        seen.add(case_id)
    payloads = [{"case": case, "sweep_id": sweep_id, "force": force} for case in cases]
    print(f"sweep {sweep_id}: {len(payloads)} cases, force={force}")
    results = list(run_case_remote.map(payloads))
    completed = sum(1 for r in results if r.get("status") == "completed")
    diverged = sum(1 for r in results if r.get("status") == "diverged")
    setup_error = sum(1 for r in results if r.get("status") == "setup_error")
    cached = sum(1 for r in results if r.get("cached"))
    print(f"sweep {sweep_id}: completed={completed} diverged={diverged} setup_error={setup_error} cached={cached}")
    print(f"sweep {sweep_id}: workers at /sweep/runs/{sweep_id}/workers/, merge locally with training/merge_sweep.py")
