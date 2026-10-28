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


# V3 multi head loss (Phase C2).
#
# Spatial heads in model output order: meanU, meanV, cp, vorticity, tke,
# recirc, uCos, uSin, vCos, vSin. Aux heads: strouhal (normalized
# regression), explained (logit in [0, 1]), harmonicValid (logit 0/1).
# Spatial regression uses masked MSE on fluid cells; recirc uses masked BCE
# with logits. Each harmonic channel is a per sample fluid MSE scaled by the
# sample harmonic weight (1.0 valid, 0.05 invalid) so invalid cases still
# flow gradients but cannot dominate. Strouhal uses masked MSE over the aux
# mask; explained and validity use masked BCE with logits. Divergence over
# the mean, cos, and sin pairs is a train only regularizer, never selected.

V3_HEAD_NAMES = ("meanU", "meanV", "cp", "vorticity", "tke", "recirc", "uCos", "uSin", "vCos", "vSin")
V3_HARM_HEADS = ("uCos", "uSin", "vCos", "vSin")
V3_AUX_NAMES = ("strouhal", "explained", "harmonicValid")

V3_HEAD_WEIGHTS: dict[str, float] = {
    "meanU": 1.0,
    "meanV": 1.0,
    "cp": 0.5,
    "vorticity": 0.25,
    "tke": 0.5,
    "recirc": 0.5,
    "uCos": 0.5,
    "uSin": 0.5,
    "vCos": 0.5,
    "vSin": 0.5,
}

V3_STROUHAL_WEIGHT = 0.5
V3_EXPLAINED_WEIGHT = 0.25
V3_VALIDITY_WEIGHT = 0.25


def _masked_bce_plain(logit: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    per_cell = F.binary_cross_entropy_with_logits(logit, target, reduction="none")
    denom = mask.sum().clamp_min(1.0)
    return (per_cell * mask).sum() / denom


def _pair_divergence(u: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    dudx = u[:, :, 1:] - u[:, :, :-1]
    dvdy = v[:, 1:, :] - v[:, :-1, :]
    div = dudx[:, :-1, :] + dvdy[:, :, :-1]
    return (div**2).mean()


def divergence_loss_v3(
    pred_spatial: torch.Tensor,
    pair_std_u: float = 1.0,
    pair_std_v: float = 1.0,
) -> torch.Tensor:
    """Mean of three squared divergence terms: mean, cos, sin pairs.

    Harmonic pairs are first multiplied by their pooled pair std to restore
    lattice velocity units (mean 0, so scale only). The mean pair stays in
    normalized model units. Returns a scalar; excluded from selection.
    """
    if pred_spatial.shape[1] != 10:
        raise ValueError(f"pred_spatial must be (B, 10, H, W), got {tuple(pred_spatial.shape)}")
    u_mean = pred_spatial[:, 0]
    v_mean = pred_spatial[:, 1]
    u_cos = pred_spatial[:, 6] * float(pair_std_u)
    v_cos = pred_spatial[:, 8] * float(pair_std_v)
    u_sin = pred_spatial[:, 7] * float(pair_std_u)
    v_sin = pred_spatial[:, 9] * float(pair_std_v)
    div_mean = _pair_divergence(u_mean, v_mean)
    div_cos = _pair_divergence(u_cos, v_cos)
    div_sin = _pair_divergence(u_sin, v_sin)
    return (div_mean + div_cos + div_sin) / 3.0


def _harmonic_sample_terms(
    pred: torch.Tensor,
    target: torch.Tensor,
    fluid: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    """Per sample fluid MSE averaged with the sample harmonic weight."""
    b = pred.shape[0]
    diff2 = (pred - target) ** 2 * fluid
    fluid_count = fluid.view(b, -1).sum(dim=1).clamp_min(1.0)
    mse_b = diff2.view(b, -1).sum(dim=1) / fluid_count
    w = weight.view(b).to(dtype=pred.dtype)
    return (w * mse_b).mean()


def _amplitude_rmse(
    pred_cos: torch.Tensor,
    pred_sin: torch.Tensor,
    tgt_cos: torch.Tensor,
    tgt_sin: torch.Tensor,
    fluid: torch.Tensor,
) -> float:
    amp_pred = torch.sqrt(pred_cos**2 + pred_sin**2)
    amp_tgt = torch.sqrt(tgt_cos**2 + tgt_sin**2)
    denom = fluid.sum().clamp_min(1.0)
    return float(torch.sqrt((((amp_pred - amp_tgt) ** 2 * fluid[:, 0]).sum() / denom).detach()))


def _phase_error(
    pred_cos: torch.Tensor,
    pred_sin: torch.Tensor,
    tgt_cos: torch.Tensor,
    tgt_sin: torch.Tensor,
    fluid: torch.Tensor,
) -> float:
    pred_phase = torch.atan2(pred_sin, pred_cos)
    tgt_phase = torch.atan2(tgt_sin, tgt_cos)
    tgt_amp = torch.sqrt(tgt_cos**2 + tgt_sin**2)
    present = (fluid[:, 0] > 0.5) & (tgt_amp > 1e-6)
    count = int(present.sum())
    if count == 0:
        return 0.0
    diff = pred_phase - tgt_phase
    wrapped = torch.atan2(torch.sin(diff), torch.cos(diff))
    return float(torch.abs(wrapped[present]).mean().detach())


def multihead_loss_v3(
    pred_spatial: torch.Tensor,
    pred_aux: torch.Tensor,
    target_spatial: torch.Tensor,
    target_aux: torch.Tensor,
    aux_mask: torch.Tensor,
    fluid: torch.Tensor,
    harmonic_weight: torch.Tensor,
    pair_std_u: float = 1.0,
    pair_std_v: float = 1.0,
    div_weight: float = 0.0,
    weights: dict[str, float] | None = None,
) -> tuple[torch.Tensor, torch.Tensor, dict[str, float]]:
    """Return (train_loss, selection, per_head). Selection excludes divergence."""
    if pred_spatial.shape != target_spatial.shape or pred_spatial.shape[1] != 10:
        raise ValueError(f"spatial must be (B, 10, H, W), got {tuple(pred_spatial.shape)}")
    b, _, h, w = pred_spatial.shape
    if tuple(fluid.shape) != (b, 1, h, w):
        raise ValueError(f"fluid must be (B, 1, H, W), got {tuple(fluid.shape)}")
    if tuple(pred_aux.shape) != (b, 3) or tuple(target_aux.shape) != (b, 3):
        raise ValueError("aux must be (B, 3)")
    if tuple(aux_mask.shape) != (b, 3):
        raise ValueError("aux_mask must be (B, 3)")
    wmap = weights or V3_HEAD_WEIGHTS
    per_head: dict[str, float] = {}
    selection = torch.zeros((), dtype=pred_spatial.dtype, device=pred_spatial.device)
    for i, name in enumerate(V3_HEAD_NAMES):
        if name == RECIRC_HEAD:
            term = _masked_bce_plain(pred_spatial[:, i : i + 1], target_spatial[:, i : i + 1], fluid)
        elif name in V3_HARM_HEADS:
            term = _harmonic_sample_terms(
                pred_spatial[:, i : i + 1], target_spatial[:, i : i + 1], fluid, harmonic_weight
            )
        else:
            term = masked_mse(pred_spatial[:, i : i + 1], target_spatial[:, i : i + 1], fluid)
        per_head[name] = float(term.detach())
        selection = selection + wmap[name] * term
    strouhal_mask = aux_mask[:, 0:1]
    strouhal_term = (((pred_aux[:, 0:1] - target_aux[:, 0:1]) ** 2 * strouhal_mask).sum() / strouhal_mask.sum().clamp_min(1.0))
    per_head["strouhal"] = float(strouhal_term.detach())
    selection = selection + V3_STROUHAL_WEIGHT * strouhal_term
    explained_term = _masked_bce_plain(pred_aux[:, 1:2], target_aux[:, 1:2], aux_mask[:, 1:2])
    per_head["explained"] = float(explained_term.detach())
    selection = selection + V3_EXPLAINED_WEIGHT * explained_term
    validity_term = _masked_bce_plain(pred_aux[:, 2:3], target_aux[:, 2:3], aux_mask[:, 2:3])
    per_head["harmonicValid"] = float(validity_term.detach())
    selection = selection + V3_VALIDITY_WEIGHT * validity_term
    div = divergence_loss_v3(pred_spatial, pair_std_u, pair_std_v) if div_weight else torch.zeros(
        (), dtype=pred_spatial.dtype, device=pred_spatial.device
    )
    per_head["divergence"] = float(div.detach())
    per_head["uAmpRMSE"] = _amplitude_rmse(
        pred_spatial[:, 6], pred_spatial[:, 7], target_spatial[:, 6], target_spatial[:, 7], fluid
    )
    per_head["vAmpRMSE"] = _amplitude_rmse(
        pred_spatial[:, 8], pred_spatial[:, 9], target_spatial[:, 8], target_spatial[:, 9], fluid
    )
    per_head["uPhaseErr"] = _phase_error(
        pred_spatial[:, 6], pred_spatial[:, 7], target_spatial[:, 6], target_spatial[:, 7], fluid
    )
    per_head["vPhaseErr"] = _phase_error(
        pred_spatial[:, 8], pred_spatial[:, 9], target_spatial[:, 8], target_spatial[:, 9], fluid
    )
    train_loss = selection + div_weight * div
    return train_loss, selection, per_head
