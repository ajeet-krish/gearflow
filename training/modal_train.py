"""Modal training app (fallback path, not required for the demo).

Run by the user only, never by agents. GPU trains on Modal, mounts a volume
for data and checkpoints, downloads the best checkpoint for local export.
Usage: modal run training/modal_train.py (from the repo root).
"""

import modal

app = modal.App("gearflow-surrogate")

image = modal.Image.debian_slim().pip_install(
    "torch==2.4.1",
    "numpy==1.26.4",
)

volume = modal.Volume.from_name("gearflow-data", create_if_missing=True)
DATA_MOUNT = "/data"
CHECKPOINT_MOUNT = "/checkpoints"


@app.function(image=image, gpu="A10G", volumes={DATA_MOUNT: volume, CHECKPOINT_MOUNT: volume}, timeout=3 * 3600)
def train_remote(epochs: int = 40, batch: int = 32, lr: float = 3e-4) -> dict:
    if not 1 <= epochs <= 500:
        raise ValueError(f"epochs {epochs} out of range [1, 500]")
    if not 1 <= batch <= 128:
        raise ValueError(f"batch {batch} out of range [1, 128]")
    if not 1e-6 <= lr <= 1e-2:
        raise ValueError(f"lr {lr} out of range [1e-6, 1e-2]")
    import sys

    sys.path.insert(0, "/root/training")
    # training/ is mounted via include; see modal run with --mount.
    import torch
    from torch.utils.data import DataLoader

    from dataset import SurrogateDataset
    from model import UNet

    from pathlib import Path

    data_dir = Path(DATA_MOUNT) / "train"
    train_set = SurrogateDataset(data_dir, "train")
    val_set = SurrogateDataset(data_dir, "val", norm=train_set.norm)
    train_set.assert_no_leakage(set(val_set.ids))
    val_set.assert_no_leakage(set(train_set.ids))
    probe_x, probe_y = train_set[0]
    if tuple(probe_x.shape) != (3, 128, 128) or tuple(probe_y.shape) != (3, 128, 128):
        raise ValueError(f"unexpected sample shapes {tuple(probe_x.shape)} {tuple(probe_y.shape)}")
    if not (torch.isfinite(probe_x).all() and torch.isfinite(probe_y).all()):
        raise ValueError("non-finite values in first train sample")
    train_loader = DataLoader(train_set, batch_size=batch, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_set, batch_size=batch, shuffle=False, num_workers=2)

    device = torch.device("cuda")
    model = UNet().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    loss_fn = torch.nn.MSELoss()
    best_val = float("inf")
    ckpt_dir = Path(CHECKPOINT_MOUNT)
    for epoch in range(epochs):
        model.train()
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            loss_fn(model(x), y).backward()
            opt.step()
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for x, y in val_loader:
                x, y = x.to(device), y.to(device)
                val_loss += loss_fn(model(x), y).item() * x.shape[0]
        val_loss /= len(val_set)
        sched.step()
        if val_loss < best_val:
            best_val = val_loss
            torch.save(
                {"model": model.state_dict(), "norm": train_set.norm, "base": 32, "epoch": epoch},
                ckpt_dir / "best.pt",
            )
        print(f"modal train: epoch={epoch + 1}/{epochs} val={val_loss:.5f}")
    volume.commit()
    return {"bestVal": best_val, "epochs": epochs}


@app.local_entrypoint()
def main(epochs: int = 40) -> None:
    result = train_remote.remote(epochs=epochs)
    print(f"modal train: done {result}")
