"""Modal training app v2: analytic pretrain plus LBM fine tune at base 8.

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
NORM_SCHEMA = "gearflow-surrogate-norm/v2"

app = modal.App("gearflow-surrogate-v2")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.5.1", "numpy==1.26.4")
    .add_local_file("training/model.py", "/root/training/model.py")
    .add_local_file("training/dataset.py", "/root/training/dataset.py")
    .add_local_file("training/dataset_v2.py", "/root/training/dataset_v2.py")
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
FINETUNE_DEFAULTS = {"epochs": 30, "batch": 16, "lr": 5e-5, "div_weight": 0.01}
ADAMW_WEIGHT_DECAY = 1e-4


def _validate_hparams(stage: str, base: int, epochs: int, batch: int, lr: float) -> None:
    if base != BASE_LOCKED:
        raise ValueError(f"{stage}: base must equal {BASE_LOCKED}, got {base}")
    if not 1 <= epochs <= 200:
        raise ValueError(f"{stage}: epochs {epochs} out of range [1, 200]")
    if not 1 <= batch <= 64:
        raise ValueError(f"{stage}: batch {batch} out of range [1, 64]")
    if not 1e-6 <= lr <= 1e-2:
        raise ValueError(f"{stage}: lr {lr} out of range [1e-6, 1e-2]")


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

    from dataset_v2 import (
        AnalyticV2Dataset,
        LbmV2Dataset,
        canonical_norm_json,
        norm_hash,
        with_refit_outputs,
    )
    from losses import compute_pos_weight, multihead_loss, per_head_rmse
    from model import UNetV2, param_count_v2

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
        train_set = AnalyticV2Dataset(data_dir, "train")
        val_set = AnalyticV2Dataset(data_dir, "val", norm=train_set.norm)
        manifest_hash = sha_of(Path(DATA_MOUNT) / "analytic" / "manifest.jsonl")
        model = UNetV2(base=base).to(device)
        norm = train_set.norm
        guard_sets: dict[str, object] = {}
    else:
        sweep_dir = Path(DATA_MOUNT) / "lbm" / sweep_id
        ckpt_path = Path(CHECKPOINT_MOUNT) / run_id / "pretrain" / "best.pt"
        if not ckpt_path.exists():
            raise ValueError(f"finetune: pretrain checkpoint missing: {ckpt_path}")
        pre = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        if pre.get("arch") != "unet-v2" or int(pre.get("base", -1)) != BASE_LOCKED:
            raise ValueError("finetune: pretrain checkpoint is not a v2 base 8 checkpoint")
        frozen_inputs_json = json.dumps(pre["norm"]["inputs"], sort_keys=True)
        _, lbm_train_raw = _lbm_raw_targets(sweep_dir, "train")
        norm = with_refit_outputs(pre["norm"], lbm_train_raw, fitted_on=f"lbm:{sweep_id}:train")
        if json.dumps(norm["inputs"], sort_keys=True) != frozen_inputs_json:
            raise ValueError("finetune: input norm drifted, must stay frozen byte for byte")
        train_set = LbmV2Dataset(sweep_dir, "train", norm=norm)
        val_set = LbmV2Dataset(sweep_dir, "val", norm=norm)
        manifest_hash = sha_of(sweep_dir / "manifest.jsonl")
        model = UNetV2(base=base).to(device)
        model.load_state_dict(pre["model"])
        analytic_dir = Path(DATA_MOUNT) / "analytic" / "train"
        guard_sets = {
            "analyticVal": AnalyticV2Dataset(analytic_dir, "val", norm=norm),
        }

    probe_x, probe_y, probe_f = train_set[0]
    if tuple(probe_x.shape) != (4, 128, 128) or tuple(probe_y.shape) != (6, 128, 128):
        raise ValueError(f"{stage}: unexpected probe shapes {tuple(probe_x.shape)} {tuple(probe_y.shape)}")
    for name, probe in (("x", probe_x), ("y", probe_y)):
        if not bool(torch.isfinite(probe).all()):
            raise ValueError(f"{stage}: non-finite values in first train sample {name}")

    train_loader = DataLoader(train_set, batch_size=batch, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_set, batch_size=batch, shuffle=False, num_workers=2)

    params = sum(p.numel() for p in model.parameters())
    expected = param_count_v2(base)
    if params != expected:
        raise ValueError(f"{stage}: param count {params} != expected {expected}")

    probe_n = min(64, len(train_set))
    pos_weight = compute_pos_weight(
        torch.stack([train_set[i][1][5] for i in range(probe_n)]).unsqueeze(1),
        torch.stack([train_set[i][2] for i in range(probe_n)]),
    )
    if not 1.0 <= pos_weight <= 20.0:
        raise ValueError(f"{stage}: pos_weight {pos_weight} outside [1, 20]")

    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=ADAMW_WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    stds = {k: float(v["std"]) for k, v in norm["outputs"].items()}
    best_composite = float("inf")
    best_epoch = -1
    history_path = out_dir / "history.jsonl"
    with open(history_path, "w") as hf:
        for epoch in range(epochs):
            model.train()
            train_loss_sum = 0.0
            for x, y, fluid in train_loader:
                x, y, fluid = x.to(device), y.to(device), fluid.to(device)
                opt.zero_grad()
                pred = model(x)
                loss, _, _ = multihead_loss(pred, y, fluid, pos_weight=pos_weight, div_weight=div_weight)
                loss.backward()
                opt.step()
                train_loss_sum += float(loss) * x.shape[0]
            train_loss_sum /= len(train_set)
            model.eval()
            val_comp_sum = 0.0
            per_head_sum: dict[str, float] = {}
            with torch.no_grad():
                for x, y, fluid in val_loader:
                    x, y, fluid = x.to(device), y.to(device), fluid.to(device)
                    pred = model(x)
                    _, comp, heads = multihead_loss(pred, y, fluid, pos_weight=pos_weight)
                    val_comp_sum += float(comp) * x.shape[0]
                    phys = per_head_rmse(pred, y, fluid, stds=stds)
                    for k, v in {**heads, **phys}.items():
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
                        for gx, gy, gf in gload:
                            gx, gy, gf = gx.to(device), gy.to(device), gf.to(device)
                            _, gcomp, _ = multihead_loss(model(gx), gy, gf, pos_weight=pos_weight)
                            gsum += float(gcomp) * gx.shape[0]
                        row[f"{gname}Composite"] = gsum / len(gset)
            hf.write(json.dumps(row) + "\n")
            sched.step()
            torch.save(
                {
                    "arch": "unet-v2",
                    "base": base,
                    "inCh": 4,
                    "outCh": 6,
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
                        "arch": "unet-v2",
                        "base": base,
                        "inCh": 4,
                        "outCh": 6,
                        "model": model.state_dict(),
                        "norm": norm,
                        "epoch": epoch,
                        "stage": stage,
                        "runId": run_id,
                    },
                    out_dir / "best.pt",
                )
            print(f"v2 {stage}: epoch={epoch + 1}/{epochs} train={train_loss_sum:.5f} val={val_comp_sum:.5f}")

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
        "schedule": {"kind": "cosine", "epochs": epochs, "batch": batch, "lr": lr, "weightDecay": ADAMW_WEIGHT_DECAY},
        "sampleCounts": {"train": len(train_set), "val": len(val_set)},
        "manifestSha256": manifest_hash,
        "normSha256": norm_hash(norm),
        "bestEpoch": best_epoch,
        "bestComposite": best_composite,
        "posWeight": pos_weight,
        "divWeight": div_weight,
        "perHeadErrors": per_head_errors,
        "wallSeconds": round(wall_seconds, 1),
        "remotePath": str(out_dir),
    }
    (out_dir / "norm.json").write_text(canonical_norm_json(norm))
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


def _lbm_raw_targets(sweep_dir: Path, split: str) -> tuple[list, list]:
    """Load raw LBM train targets for output norm refit (remote helper)."""
    from pathlib import Path as _Path

    from dataset_v2 import LbmV2Dataset

    ds = LbmV2Dataset(_Path(sweep_dir), split)
    return ds._load_all_raw()


@app.local_entrypoint()
def main(action: str = "train", run_id: str = "dev", sweep_id: str = "pilot") -> None:
    if action == "sweep":
        raise NotImplementedError("sweep is a C-2 stub: run training/modal_sweep.py (not built yet)")
    if action != "train":
        raise ValueError(f"action must be train or sweep, got {action!r}")

    git_sha = _local_git_sha()
    print(f"v2 train: local git sha {git_sha}")

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
    print(f"v2 pretrain done: {pre}")
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
    print(f"v2 finetune done: {ft}")
    dest = Path("training") / "checkpoints" / "v2" / run_id
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("best.pt", "norm.json", "run_log.json"):
        data = ckpt_volume.read_file(f"{run_id}/finetune/{name}")
        (dest / name).write_bytes(data if isinstance(data, bytes) else data.encode())
    print(f"v2 train: downloaded to {dest}")
