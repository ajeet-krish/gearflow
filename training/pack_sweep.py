"""Pack sweep workers into one archive for single file download.

Run by the user only, never by agents. Modal auth lives in the user local
Modal profile, no secret is read from the repo. Single run command from the
repo root:

    modal run training/pack_sweep.py --sweep-id <sweep_id>

Packs the sweep workers on the gearflow-sweep volume at /sweep:

    /sweep/runs/<sweep_id>/workers/<case_id>/...

into a single archive:

    /sweep/runs/<sweep_id>/workers.tar.gz

so the user downloads one file instead of fighting `modal volume get`
directory recursion (which fails locally with Errno 21 Is a directory in
modal 1.6.2). Zero image build is needed for the remote step.
"""

import subprocess
from pathlib import Path

import modal

app = modal.App("gearflow-sweep-pack")

sweep_volume = modal.Volume.from_name("gearflow-sweep")
SWEEP_MOUNT = "/sweep"


@app.function(
    image=modal.Image.debian_slim(),
    volumes={SWEEP_MOUNT: sweep_volume},
    timeout=600,
)
def pack_workers_remote(sweep_id: str) -> dict:
    """Tar the workers dir for sweep_id into workers.tar.gz on the volume."""
    workers = Path(SWEEP_MOUNT) / "runs" / sweep_id / "workers"
    if not workers.is_dir():
        raise FileNotFoundError(f"workers dir missing for sweep {sweep_id}: {workers}")
    case_dirs = [entry for entry in workers.iterdir() if entry.is_dir()]
    if not case_dirs:
        raise FileNotFoundError(f"workers dir holds no case dirs for sweep {sweep_id}: {workers}")
    archive = Path(SWEEP_MOUNT) / "runs" / sweep_id / "workers.tar.gz"
    subprocess.run(
        ["tar", "-czf", str(archive), "-C", str(workers), "."],
        check=True,
    )
    size_bytes = archive.stat().st_size
    listing = subprocess.run(
        ["tar", "-tzf", str(archive)],
        capture_output=True,
        text=True,
        check=True,
    )
    entry_count = sum(1 for line in listing.stdout.splitlines() if line.strip())
    print(f"packed {len(case_dirs)} case dirs into {archive} ({size_bytes} bytes, {entry_count} entries)")
    return {"archive": str(archive), "size_bytes": size_bytes, "entry_count": entry_count}


@app.local_entrypoint()
def main(sweep_id: str) -> None:
    """Pack workers remotely, then print the single file download command."""
    result = pack_workers_remote.remote(sweep_id)
    remote_path = result["archive"]
    print(f"archive ready: {remote_path}")
    print(f"download with: modal volume get gearflow-sweep runs/{sweep_id}/workers.tar.gz ./workers.tar.gz")
