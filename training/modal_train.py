"""Modal training app v3: analytic pretrain plus LBM fine tune at base 8.

Run by the user only, never by agents. Modal auth lives in the user local
Modal profile; no secret is read from the repo and no credential material
enters code or logs. Single run command from the repo root:

    modal run training/modal_train.py

GPU work runs on Modal (A10G first with L4 fallback). Nothing here runs a
remote job on import; the local pytest suite never touches Modal.
"""

import modal
import re
import subprocess
from pathlib import Path

RUN_LOG_SCHEMA = "gearflow-run-log/v1"
NORM_SCHEMA = "gearflow-surrogate-norm/v3"

app = modal.App("gearflow-surrogate-v3")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.5.1", "numpy==1.26.4")
    .add_local_file("training/model.py", "/root/training/model.py")
    .add_local_file("training/dataset.py", "/root/training/dataset.py")
    .add_local_file("training/dataset_v2.py", "/root/training/dataset_v2.py")
    .add_local_file("training/dataset_v3.py", "/root/training/dataset_v3.py")
    .add_local_file("training/losses.py", "/root/training/losses.py")
    .env({"PYTHONUNBUFFERED": "1"})
)

data_volume = modal.Volume.from_name("gearflow-data", create_if_missing=True)
ckpt_volume = modal.Volume.from_name("gearflow-checkpoints", create_if_missing=True)
DATA_MOUNT = "/data"
CHECKPOINT_MOUNT = "/checkpoints"

GPU_REQUESTED = ["A10G", "L4"]
CPU_COUNT = 4
MEMORY_MB = 16384
STAGE_TIMEOUT = 7200
SCALEDOWN_WINDOW = 300

# Retry semantics: retries=2 on run_stage covers transient infrastructure loss
# only (container preemption, network blips). The stage body fails closed on
# application errors (bad shapes, param drift, missing checkpoints) by raising,
# and a retried attempt revalidates from scratch, so a retry never resumes a
# half written stage. Modal has no per exception retry filter here, so the
# comment is the contract: infra loss may retry, app errors must surface.
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _local_git_sha() -> str:
    """Best effort local git sha for the run log, unknown fallback."""
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"
    return sha if GIT_SHA_RE.match(sha) else "unknown"

BASE_LOCKED = 8
PRETRAIN_DEFAULTS = {"epochs": 60, "batch": 32, "lr": 3e-4, "div_weight": 0.0}
FINETUNE_DEFAULTS = {"epochs": 200, "batch": 8, "lr": 5e-5, "div_weight": 0.01}
ADAMW_WEIGHT_DECAY = 1e-4
ARTIFACT_NAMES = ("best.pt", "norm.json", "run_log.json")
HARM_MIN_VALID = 8


def _validate_hparams(stage: str, base: int, epochs: int, batch: int, lr: float) -> None:
    if base != BASE_LOCKED:
        raise ValueError(f"{stage}: base must equal {BASE_LOCKED}, got {base}")
    if not 1 <= epochs <= 300:
        raise ValueError(f"{stage}: epochs {epochs} out of range [1, 300]")
    if not 1 <= batch <= 64:
        raise ValueError(f"{stage}: batch {batch} out of range [1, 64]")
    if not 1e-6 <= lr <= 1e-2:
        raise ValueError(f"{stage}: lr {lr} out of range [1e-6, 1e-2]")


def _harmonic_capable(harm_train: int, epochs_done: int) -> bool:
    """True only with enough harmonic valid train cases plus real training.

    The fine tune train split needs at least HARM_MIN_VALID harmonic valid
    cases, and the run must have completed at least one epoch, before the
    checkpoint may advertise harmonic capability.
    """
    return int(harm_train) >= HARM_MIN_VALID and int(epochs_done) >= 1


def _completed_lbm_rows(sweep_dir: Path) -> list:
    """Completed LBM manifest rows for a sweep dir, without torch imports.

    Mirrors dataset_v2.is_completed_row (absent status counts as completed,
    only the literal completed status or absent passes) so the local entry
    path can fail closed before any GPU work starts.
    """
    import json

    manifest = Path(sweep_dir) / "manifest.jsonl"
    rows = []
    with open(manifest) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    kept = []
    for row in rows:
        status = row.get("status", None)
        if status is None or str(status) == "completed":
            kept.append(row)
    return kept


def _require_completed_rows(sweep_dir: Path) -> list:
    """Fail closed when a sweep has zero completed LBM rows to train on."""
    completed = _completed_lbm_rows(sweep_dir)
    if not completed:
        raise ValueError(f"finetune: zero completed LBM rows in {sweep_dir}, cannot fit v3 norm")
    return completed


@app.function(
    image=image,
    gpu=GPU_REQUESTED,
    cpu=CPU_COUNT,
    memory=MEMORY_MB,
    volumes={DATA_MOUNT: data_volume, CHECKPOINT_MOUNT: ckpt_volume},
    timeout=STAGE_TIMEOUT,
    scaledown_window=SCALEDOWN_WINDOW,
    retries=2,
)
def run_stage(
    stage: str,
    run_id: str,
    sweep_id: str = "pilot",
    base: int = BASE_LOCKED,
    epochs: int = 60,
    batch: int = 32,
    lr: float = 3e-4,
    div_weight: float = 0.0,
    git_sha: str = "unknown",
) -> dict:
    """Run one stage (pretrain or finetune) on the remote GPU worker.

    git_sha arrives from the local entrypoint (local git rev-parse HEAD with
    unknown fallback) because the remote container has no repo checkout.
    """
    import datetime
    import hashlib
    import json
    import re
    import sys
    import time
    from pathlib import Path

    _validate_hparams(stage, base, epochs, batch, lr)
    if stage not in ("pretrain", "finetune"):
        raise ValueError(f"stage must be pretrain or finetune, got {stage!r}")

    sys.path.insert(0, "/root/training")
    import torch
    from torch.utils.data import DataLoader

    from dataset_v3 import (
        AnalyticV3Dataset,
        LbmV3Dataset,
        canonical_norm_json_v3,
        norm_hash_v3,
        with_refit_outputs_v3,
    )
    from losses import multihead_loss_v3
    from model import UNetV3, param_count_v3

    if not torch.cuda.is_available():
        raise RuntimeError(f"{stage}: no CUDA device, failing closed (GPU required)")
    device = torch.device("cuda")
    actual_gpu = torch.cuda.get_device_name(0)

    git_sha = git_sha if re.match(r"^[0-9a-f]{40}$", git_sha) else "unknown"

    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    t0 = time.time()
    out_dir = Path(CHECKPOINT_MOUNT) / run_id / stage
    out_dir.mkdir(parents=True, exist_ok=True)

    def sha_of(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    if stage == "pretrain":
        data_dir = Path(DATA_MOUNT) / "analytic" / "train"
        train_set = AnalyticV3Dataset(data_dir, "train")
        val_set = AnalyticV3Dataset(data_dir, "val", norm=train_set.norm)
        manifest_hash = sha_of(Path(DATA_MOUNT) / "analytic" / "manifest.jsonl")
        model = UNetV3(base=base).to(device)
        norm = train_set.norm
        harm_train = 0
        harm_val = 0
        guard_sets: dict[str, object] = {}
    else:
        sweep_dir = Path(DATA_MOUNT) / "lbm" / sweep_id
        ckpt_path = Path(CHECKPOINT_MOUNT) / run_id / "pretrain" / "best.pt"
        if not ckpt_path.exists():
            raise ValueError(f"finetune: pretrain checkpoint missing: {ckpt_path}")
        pre = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        if pre.get("arch") != "unet-v3" or int(pre.get("base", -1)) != BASE_LOCKED:
            raise ValueError("finetune: pretrain checkpoint is not a v3 base 8 checkpoint")
        frozen_inputs_json = json.dumps(pre["norm"]["inputs"], sort_keys=True)
        completed = _completed_lbm_rows(sweep_dir)
        if not completed:
            raise ValueError(f"finetune: zero completed LBM rows in {sweep_dir}, cannot fit v3 norm")
        _, lbm_raw_targets = _lbm_raw_targets_v3(sweep_dir, "train")
        raw_inputs, raw_spatial, raw_strouhal = lbm_raw_targets
        norm = with_refit_outputs_v3(pre["norm"], raw_inputs, raw_spatial, raw_strouhal, fitted_on=f"lbm:{sweep_id}:train")
        if json.dumps(norm["inputs"], sort_keys=True) != frozen_inputs_json:
            raise ValueError("finetune: input norm drifted, must stay frozen byte for byte")
        train_set = LbmV3Dataset(sweep_dir, "train", norm=norm)
        val_set = LbmV3Dataset(sweep_dir, "val", norm=norm)
        if len(train_set) == 0:
            raise ValueError(f"finetune: zero completed LBM rows in train split of {sweep_dir}")
        manifest_hash = sha_of(sweep_dir / "manifest.jsonl")
        model = UNetV3(base=base).to(device)
        model.load_state_dict(pre["model"])
        analytic_dir = Path(DATA_MOUNT) / "analytic" / "train"
        guard_sets = {
            "analyticVal": AnalyticV3Dataset(analytic_dir, "val", norm=norm),
        }
        harm_train = int(train_set.harmonic_train_count)
        harm_val = int(train_set.harmonic_val_count)

    probe = train_set[0]
    if len(probe) != 6:
        raise ValueError(f"{stage}: expected a 6 tuple batch, got {len(probe)} items")
    probe_x, probe_y, probe_f, probe_aux, probe_aux_mask, probe_w = probe
    if tuple(probe_x.shape) != (4, 128, 128) or tuple(probe_y.shape) != (10, 128, 128):
        raise ValueError(f"{stage}: unexpected probe shapes {tuple(probe_x.shape)} {tuple(probe_y.shape)}")
    if tuple(probe_f.shape) != (1, 128, 128) or tuple(probe_aux.shape) != (3,):
        raise ValueError(f"{stage}: unexpected mask shapes {tuple(probe_f.shape)} {tuple(probe_aux.shape)}")
    if tuple(probe_aux_mask.shape) != (3,):
        raise ValueError(f"{stage}: unexpected aux mask shape {tuple(probe_aux_mask.shape)}")
    for name, probe_t in (("x", probe_x), ("y", probe_y), ("aux", probe_aux)):
        if not bool(torch.isfinite(probe_t).all()):
            raise ValueError(f"{stage}: non-finite values in first train sample {name}")

    train_loader = DataLoader(train_set, batch_size=batch, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_set, batch_size=batch, shuffle=False, num_workers=2)

    params = sum(p.numel() for p in model.parameters())
    expected = param_count_v3(base)
    if params != expected:
        raise ValueError(f"{stage}: param count {params} != expected {expected}")

    pair_std_u = float(norm["outputs"]["uCos"]["std"])
    pair_std_v = float(norm["outputs"]["vCos"]["std"])

    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=ADAMW_WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    best_composite = float("inf")
    best_epoch = -1
    history_path = out_dir / "history.jsonl"
    with open(history_path, "w") as hf:
        for epoch in range(epochs):
            model.train()
            train_loss_sum = 0.0
            for x, y, fluid, aux, aux_mask, weight in train_loader:
                x = x.to(device)
                y = y.to(device)
                fluid = fluid.to(device)
                aux = aux.to(device)
                aux_mask = aux_mask.to(device)
                weight = weight.to(device)
                opt.zero_grad()
                pred_spatial, pred_aux = model(x)
                loss, _, _ = multihead_loss_v3(
                    pred_spatial,
                    pred_aux,
                    y,
                    aux,
                    aux_mask,
                    fluid,
                    weight,
                    pair_std_u=pair_std_u,
                    pair_std_v=pair_std_v,
                    div_weight=div_weight,
                )
                loss.backward()
                opt.step()
                train_loss_sum += float(loss) * x.shape[0]
            train_loss_sum /= len(train_set)
            model.eval()
            val_comp_sum = 0.0
            per_head_sum: dict[str, float] = {}
            with torch.no_grad():
                for x, y, fluid, aux, aux_mask, weight in val_loader:
                    x = x.to(device)
                    y = y.to(device)
                    fluid = fluid.to(device)
                    aux = aux.to(device)
                    aux_mask = aux_mask.to(device)
                    weight = weight.to(device)
                    pred_spatial, pred_aux = model(x)
                    _, comp, heads = multihead_loss_v3(
                        pred_spatial,
                        pred_aux,
                        y,
                        aux,
                        aux_mask,
                        fluid,
                        weight,
                        pair_std_u=pair_std_u,
                        pair_std_v=pair_std_v,
                    )
                    val_comp_sum += float(comp) * x.shape[0]
                    for k, v in heads.items():
                        per_head_sum[k] = per_head_sum.get(k, 0.0) + float(v) * x.shape[0]
            val_comp_sum /= len(val_set)
            row = {
                "epoch": epoch,
                "trainLoss": train_loss_sum,
                "valComposite": val_comp_sum,
                **{k: v / len(val_set) for k, v in per_head_sum.items()},
            }
            if guard_sets:
                with torch.no_grad():
                    for gname, gset in guard_sets.items():
                        gload = DataLoader(gset, batch_size=batch, shuffle=False, num_workers=2)
                        gsum = 0.0
                        for gx, gy, gf, gaux, gaux_mask, gw in gload:
                            gx = gx.to(device)
                            gy = gy.to(device)
                            gf = gf.to(device)
                            gaux = gaux.to(device)
                            gaux_mask = gaux_mask.to(device)
                            gw = gw.to(device)
                            gpred_spatial, gpred_aux = model(gx)
                            _, gcomp, _ = multihead_loss_v3(
                                gpred_spatial,
                                gpred_aux,
                                gy,
                                gaux,
                                gaux_mask,
                                gf,
                                gw,
                                pair_std_u=pair_std_u,
                                pair_std_v=pair_std_v,
                            )
                            gsum += float(gcomp) * gx.shape[0]
                        row[f"{gname}Composite"] = gsum / len(gset)
            hf.write(json.dumps(row) + "\n")
            sched.step()
            capable_now = _harmonic_capable(harm_train, epoch + 1)
            torch.save(
                {
                    "arch": "unet-v3",
                    "base": base,
                    "inCh": 4,
                    "outCh": 10,
                    "auxCh": 3,
                    "normSchema": NORM_SCHEMA,
                    "harmonicCapable": capable_now,
                    "harmonicTrain": harm_train,
                    "harmonicVal": harm_val,
                    "model": model.state_dict(),
                    "norm": norm,
                    "epoch": epoch,
                    "stage": stage,
                    "runId": run_id,
                },
                out_dir / "last.pt",
            )
            if val_comp_sum < best_composite:
                best_composite = val_comp_sum
                best_epoch = epoch
                torch.save(
                    {
                        "arch": "unet-v3",
                        "base": base,
                        "inCh": 4,
                        "outCh": 10,
                        "auxCh": 3,
                        "normSchema": NORM_SCHEMA,
                        "harmonicCapable": capable_now,
                        "harmonicTrain": harm_train,
                        "harmonicVal": harm_val,
                        "model": model.state_dict(),
                        "norm": norm,
                        "epoch": epoch,
                        "stage": stage,
                        "runId": run_id,
                    },
                    out_dir / "best.pt",
                )
            print(f"v3 {stage}: epoch={epoch + 1}/{epochs} train={train_loss_sum:.5f} val={val_comp_sum:.5f}")

    with open(history_path) as hf:
        best_row = [json.loads(line) for line in hf if json.loads(line)["epoch"] == best_epoch][0]
    per_head_errors = {k: v for k, v in best_row.items() if k not in ("epoch", "trainLoss", "valComposite")}
    wall_seconds = time.time() - t0
    run_log = {
        "schema": RUN_LOG_SCHEMA,
        "runId": run_id,
        "stage": stage,
        "status": "ok",
        "startedUtc": started,
        "endedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "gitSha": git_sha,
        "gpuRequested": GPU_REQUESTED,
        "gpuActual": actual_gpu,
        "versions": {"torch": torch.__version__},
        "base": base,
        "params": params,
        "arch": "unet-v3",
        "spatialHeads": 10,
        "auxHeads": 3,
        "normSchema": NORM_SCHEMA,
        "harmonicCapable": _harmonic_capable(harm_train, best_epoch + 1),
        "harmonicTrain": harm_train,
        "harmonicVal": harm_val,
        "schedule": {"kind": "cosine", "epochs": epochs, "batch": batch, "lr": lr, "weightDecay": ADAMW_WEIGHT_DECAY},
        "sampleCounts": {"train": len(train_set), "val": len(val_set)},
        "manifestSha256": manifest_hash,
        "normSha256": norm_hash_v3(norm),
        "bestEpoch": best_epoch,
        "bestComposite": best_composite,
        "divWeight": div_weight,
        "pairStdU": pair_std_u,
        "pairStdV": pair_std_v,
        "perHeadErrors": per_head_errors,
        "wallSeconds": round(wall_seconds, 1),
        "remotePath": str(out_dir),
    }
    (out_dir / "norm.json").write_text(canonical_norm_json_v3(norm))
    (out_dir / "run_log.json").write_text(json.dumps(run_log, indent=2) + "\n")

    ckpt_volume.commit()
    return {
        "stage": stage,
        "runId": run_id,
        "bestComposite": best_composite,
        "bestEpoch": best_epoch,
        "params": params,
        "gpuActual": actual_gpu,
        "wallSeconds": round(wall_seconds, 1),
    }


def _lbm_raw_targets_v3(sweep_dir: Path, split: str) -> tuple[list, tuple]:
    """Load raw LBM train inputs, spatial targets, and strouhal values.

    Remote helper for the output and aux norm refit on the LBM train split.
    """
    from pathlib import Path as _Path

    from dataset_v3 import LbmV3Dataset

    ds = LbmV3Dataset(_Path(sweep_dir), split)
    return split, ds._load_all_raw()


def _pretrain_checkpoint_remote(run_id: str) -> str:
    """Remote volume path for the pretrain best checkpoint."""
    return f"{run_id}/pretrain/best.pt"


def _require_pretrain_checkpoint(run_id: str) -> None:
    """Fail closed when finetune only has no pretrain checkpoint to resume."""
    try:
        probe = ckpt_volume.read_file(_pretrain_checkpoint_remote(run_id))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"finetune: pretrain checkpoint missing for run {run_id!r}") from exc
    if not probe:
        raise ValueError(f"finetune: pretrain checkpoint missing for run {run_id!r}")


def _download_routes(action: str, run_id: str) -> list:
    """Pure routing table for checkpoint downloads, no volume access.

    Combined train and finetune only resolve to the root contract with
    finetune artifacts. Pretrain only resolves to the pretrain subdir so a
    user can inspect pretrain before paying for finetune.
    """
    base = Path("training") / "checkpoints" / "v3" / run_id
    if action == "pretrain":
        return [(f"{run_id}/pretrain/{name}", base / "pretrain" / name) for name in ARTIFACT_NAMES]
    if action in ("train", "finetune"):
        return [(f"{run_id}/finetune/{name}", base / name) for name in ARTIFACT_NAMES]
    raise ValueError(f"action must be train, pretrain, finetune, or sweep, got {action!r}")


def _download_artifacts(routes: list) -> Path | None:
    """Fetch each (remote path, local path) pair from the checkpoint volume."""
    dest: Path | None = None
    for remote_path, local_path in routes:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        data = ckpt_volume.read_file(remote_path)
        local_path.write_bytes(data if isinstance(data, bytes) else data.encode())
        dest = local_path.parent
    return dest


@app.local_entrypoint()
def main(action: str = "train", run_id: str = "dev", sweep_id: str = "pilot") -> None:
    if action == "sweep":
        raise NotImplementedError("sweep runs in training/modal_sweep.py, run that module with a sweep id")
    if action not in ("train", "pretrain", "finetune"):
        raise ValueError(f"action must be train, pretrain, finetune, or sweep, got {action!r}")

    git_sha = _local_git_sha()
    print(f"v3 {action}: local git sha {git_sha}")

    if action in ("train", "pretrain"):
        pre = run_stage.remote(
            "pretrain",
            run_id,
            sweep_id,
            BASE_LOCKED,
            PRETRAIN_DEFAULTS["epochs"],
            PRETRAIN_DEFAULTS["batch"],
            PRETRAIN_DEFAULTS["lr"],
            PRETRAIN_DEFAULTS["div_weight"],
            git_sha,
        )
        print(f"v3 pretrain done: {pre}")
    if action in ("train", "finetune"):
        if action == "finetune":
            _require_pretrain_checkpoint(run_id)
        ft = run_stage.remote(
            "finetune",
            run_id,
            sweep_id,
            BASE_LOCKED,
            FINETUNE_DEFAULTS["epochs"],
            FINETUNE_DEFAULTS["batch"],
            FINETUNE_DEFAULTS["lr"],
            FINETUNE_DEFAULTS["div_weight"],
            git_sha,
        )
        print(f"v3 finetune done: {ft}")
    routes = _download_routes(action, run_id)
    dest = _download_artifacts(routes)
    print(f"v3 {action}: downloaded to {dest}")
