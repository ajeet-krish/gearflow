"""Masked multi head loss for the v2 surrogate (Modal C-1).

Heads in model output order: meanU, meanV, cp, vorticity, tke, recirc.
The first five are regression on normalized targets (tke is log1p
transformed before normalization); recirc is a raw logit trained with BCE
with logits. All terms are averaged over fluid cells only. Solid cells are
excluded from the loss and read as 0 at inference.

Default weights per docs/ARCHITECTURE.md: meanU 1.0, meanV 1.0, cp 0.5,
vorticity 0.25, tke 0.5, recirc 0.5. The optional divergence regularizer
defaults to 0.0 and is never part of the selection composite.
"""

import torch
import torch.nn.functional as F

HEAD_NAMES = ("meanU", "meanV", "cp", "vorticity", "tke", "recirc")
REGRESSION_HEADS = HEAD_NAMES[:5]
RECIRC_HEAD = "recirc"

HEAD_WEIGHTS: dict[str, float] = {
    "meanU": 1.0,
    "meanV": 1.0,
    "cp": 0.5,
    "vorticity": 0.25,
    "tke": 0.5,
    "recirc": 0.5,
}

POS_WEIGHT_MIN = 1.0
POS_WEIGHT_MAX = 20.0


def fluid_mask_from_inputs(x: torch.Tensor, mask_index: int = 1) -> torch.Tensor:
    """Fluid mask (1, H, W) per sample from the v2 mask input channel."""
    mask = x[:, mask_index : mask_index + 1]
    return (mask < 0.5).to(dtype=x.dtype)


def compute_pos_weight(recirc: torch.Tensor, fluid: torch.Tensor) -> float:
    """Negative over positive ratio on fluid cells, clamped to [1, 20]."""
    fluid = fluid > 0.5
    pos = float(((recirc > 0.5) & fluid).sum())
    total = float(fluid.sum())
    if pos <= 0.0 or total <= pos:
        return POS_WEIGHT_MIN
    return float(min(max(total / pos - 1.0, POS_WEIGHT_MIN), POS_WEIGHT_MAX))


def masked_mse(pred: torch.Tensor, target: torch.Tensor, fluid: torch.Tensor) -> torch.Tensor:
    denom = fluid.sum().clamp_min(1.0)
    return (((pred - target) ** 2 * fluid).sum() / denom).to(dtype=pred.dtype)


def masked_bce_with_logits(
    logit: torch.Tensor, target: torch.Tensor, fluid: torch.Tensor, pos_weight: float
) -> torch.Tensor:
    pw = torch.as_tensor(pos_weight, dtype=logit.dtype, device=logit.device)
    per_cell = F.binary_cross_entropy_with_logits(logit, target, pos_weight=pw, reduction="none")
    denom = fluid.sum().clamp_min(1.0)
    return (per_cell * fluid).sum() / denom


def divergence_loss(pred: torch.Tensor) -> torch.Tensor:
    """Mean squared divergence of the (meanU, meanV) heads, unit spacing."""
    u = pred[:, 0]
    v = pred[:, 1]
    dudx = u[:, :, 1:] - u[:, :, :-1]
    dvdy = v[:, 1:, :] - v[:, :-1, :]
    div = dudx[:, :-1, :] + dvdy[:, :, :-1]
    return (div**2).mean()


def multihead_loss(
    pred: torch.Tensor,
    target: torch.Tensor,
    fluid: torch.Tensor,
    pos_weight: float | None = None,
    div_weight: float = 0.0,
    weights: dict[str, float] | None = None,
) -> tuple[torch.Tensor, torch.Tensor, dict[str, float]]:
    """Return (train_loss, composite, per_head). Composite excludes divergence."""
    if pred.shape != target.shape or pred.shape[1] != 6:
        raise ValueError(f"pred/target must be (B, 6, H, W), got {tuple(pred.shape)}")
    if tuple(fluid.shape) != (pred.shape[0], 1, pred.shape[2], pred.shape[3]):
        raise ValueError(f"fluid must be (B, 1, H, W), got {tuple(fluid.shape)}")
    w = weights or HEAD_WEIGHTS
    if pos_weight is None:
        pos_weight = compute_pos_weight(target[:, 5:6], fluid)
    per_head: dict[str, float] = {}
    composite = torch.zeros((), dtype=pred.dtype, device=pred.device)
    for i, name in enumerate(HEAD_NAMES):
        if name == RECIRC_HEAD:
            term = masked_bce_with_logits(pred[:, i : i + 1], target[:, i : i + 1], fluid, pos_weight)
        else:
            term = masked_mse(pred[:, i : i + 1], target[:, i : i + 1], fluid)
        per_head[name] = float(term.detach())
        composite = composite + w[name] * term
    div = divergence_loss(pred) if div_weight else torch.zeros((), dtype=pred.dtype, device=pred.device)
    per_head["divergence"] = float(div.detach())
    train_loss = composite + div_weight * div
    return train_loss, composite, per_head


def per_head_rmse(
    pred: torch.Tensor,
    target: torch.Tensor,
    fluid: torch.Tensor,
    stds: dict[str, float] | None = None,
) -> dict[str, float]:
    """Physical RMSE per regression head plus recirc accuracy, fluid only."""
    if tuple(fluid.shape) != (pred.shape[0], 1, pred.shape[2], pred.shape[3]):
        raise ValueError(f"fluid must be (B, 1, H, W), got {tuple(fluid.shape)}")
    fluid_bool = fluid > 0.5
    count = max(int(fluid_bool.sum()), 1)
    out: dict[str, float] = {}
    for i, name in enumerate(HEAD_NAMES):
        if name == RECIRC_HEAD:
            acc = ((pred[:, i] > 0.0) == (target[:, i] > 0.5)) & fluid_bool[:, 0]
            out["recircAcc"] = float(acc.sum()) / count
            continue
        scale = float(stds[name]) if stds and name in stds else 1.0
        diff = (pred[:, i : i + 1] - target[:, i : i + 1]) * scale
        out[name] = float(torch.sqrt((diff**2 * fluid).sum() / count))
    return out
