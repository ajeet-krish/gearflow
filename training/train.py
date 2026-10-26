"""Local surrogate training entry. Run by the user, never by agents.

Usage: uv run --project training python -m train (from training/ or repo root
with adjusted paths). Auto-detects CUDA first, then MPS, then CPU. AdamW with
cosine LR, checkpoints the best validation loss, saves to
training/checkpoints/. Prints a training summary at the end.
"""

import argparse
import json
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from dataset import SurrogateDataset
from model import UNet

HERE = Path(__file__).parent
DATA_DIR = HERE.parent / "data" / "train"
CHECKPOINT_DIR = HERE / "checkpoints"


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the GearFlow surrogate U-Net")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--base", type=int, default=32)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 500:
        raise SystemExit(f"train: --epochs {args.epochs} out of range [1, 500]")
    if not 1 <= args.batch <= 128:
        raise SystemExit(f"train: --batch {args.batch} out of range [1, 128]")
    if not 1e-6 <= args.lr <= 1e-2:
        raise SystemExit(f"train: --lr {args.lr} out of range [1e-6, 1e-2]")
    if not 1 <= args.base <= 64:
        raise SystemExit(f"train: --base {args.base} out of range [1, 64]")
    if not 0 <= args.workers <= 8:
        raise SystemExit(f"train: --workers {args.workers} out of range [0, 8]")

    device = pick_device()
    print(f"train: device={device} epochs={args.epochs} batch={args.batch} lr={args.lr}")

    train_set = SurrogateDataset(DATA_DIR, "train")
    val_set = SurrogateDataset(DATA_DIR, "val", norm=train_set.norm)
    train_set.assert_no_leakage(set(val_set.ids))
    val_set.assert_no_leakage(set(train_set.ids))
    print(f"train: samples train={len(train_set)} val={len(val_set)}")

    train_loader = DataLoader(train_set, batch_size=args.batch, shuffle=True, num_workers=args.workers)
    val_loader = DataLoader(val_set, batch_size=args.batch, shuffle=False, num_workers=args.workers)

    probe_x, probe_y = train_set[0]
    if tuple(probe_x.shape) != (3, 128, 128) or tuple(probe_y.shape) != (3, 128, 128):
        raise SystemExit(f"train: unexpected sample shapes {tuple(probe_x.shape)} {tuple(probe_y.shape)}")
    if not (torch.isfinite(probe_x).all() and torch.isfinite(probe_y).all()):
        raise SystemExit("train: non-finite values in first train sample")

    model = UNet(base=args.base).to(device)
    params = sum(p.numel() for p in model.parameters())
    print(f"train: params={params}")

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    loss_fn = torch.nn.MSELoss()

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    best_val = float("inf")
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        train_loss = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            pred = model(x)
            loss = loss_fn(pred, y)
            loss.backward()
            opt.step()
            train_loss += loss.item() * x.shape[0]
        train_loss /= len(train_set)
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for x, y in val_loader:
                x, y = x.to(device), y.to(device)
                val_loss += loss_fn(model(x), y).item() * x.shape[0]
        val_loss /= len(val_set)
        sched.step()
        tag = ""
        if val_loss < best_val:
            best_val = val_loss
            torch.save(
                {"model": model.state_dict(), "norm": train_set.norm, "base": args.base, "epoch": epoch},
                CHECKPOINT_DIR / "best.pt",
            )
            tag = " (best)"
        print(f"train: epoch={epoch + 1}/{args.epochs} train={train_loss:.5f} val={val_loss:.5f}{tag}")

    secs = time.time() - t0
    summary = {
        "device": str(device),
        "epochs": args.epochs,
        "trainSamples": len(train_set),
        "valSamples": len(val_set),
        "bestVal": best_val,
        "seconds": round(secs, 1),
        "params": params,
    }
    print("train: summary " + json.dumps(summary))
    with open(CHECKPOINT_DIR / "summary.json", "w") as f:
        json.dump(summary, f, indent=2)


if __name__ == "__main__":
    main()
