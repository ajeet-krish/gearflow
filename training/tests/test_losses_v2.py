"""Masked multi head loss: fluid only masking, weights, clamps, selection."""

import torch
import pytest

from losses import (
    HEAD_WEIGHTS,
    compute_pos_weight,
    divergence_loss,
    masked_bce_with_logits,
    masked_mse,
    multihead_loss,
    per_head_rmse,
)


def _batch() -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    torch.manual_seed(3)
    pred = torch.randn(2, 6, 8, 8)
    target = torch.randn(2, 6, 8, 8)
    target[:, 5] = (target[:, 5] > 0.0).float()
    fluid = torch.ones(2, 1, 8, 8)
    fluid[:, :, :2, :2] = 0.0
    return pred, target, fluid


def test_loss_ignores_solid_cells() -> None:
    pred, target, fluid = _batch()
    _, comp_full, _ = multihead_loss(pred, target, fluid)
    assert float(comp_full) > 0.0
    perturbed = pred.clone()
    perturbed[:, :, :2, :2] = perturbed[:, :, :2, :2] + 5.0
    _, comp_perturbed, _ = multihead_loss(perturbed, target, fluid)
    assert float(comp_perturbed) == float(comp_full)
    exact = target.clone()
    exact[:, 5] = torch.where(target[:, 5] > 0.5, torch.tensor(10.0), torch.tensor(-10.0))
    _, comp_exact, _ = multihead_loss(exact, target, fluid)
    assert float(comp_exact) < 1e-3


def test_masked_mse_matches_manual() -> None:
    pred = torch.tensor([[[[1.0, 2.0], [3.0, 4.0]]]])
    target = torch.tensor([[[[1.0, 0.0], [3.0, 0.0]]]])
    fluid = torch.tensor([[[[1.0, 1.0], [1.0, 0.0]]]])
    assert float(masked_mse(pred, target, fluid)) == pytest.approx(4.0 / 3.0)


def test_pos_weight_clamped() -> None:
    recirc = torch.tensor([[[[1.0, 0.0], [0.0, 0.0]]]])
    fluid = torch.ones(1, 1, 2, 2)
    assert compute_pos_weight(recirc, fluid) == 3.0
    assert compute_pos_weight(torch.ones(1, 1, 2, 2), torch.ones(1, 1, 2, 2)) == 1.0
    rare = torch.zeros(1, 1, 1, 100)
    rare[:, :, 0, 0] = 1.0
    assert compute_pos_weight(rare, torch.ones(1, 1, 1, 100)) == 20.0


def test_divergence_excluded_from_composite() -> None:
    pred, target, fluid = _batch()
    train, comp_plain, heads_plain = multihead_loss(pred, target, fluid, div_weight=0.0)
    train_reg, comp_reg, heads_reg = multihead_loss(pred, target, fluid, div_weight=0.01)
    assert float(comp_plain) == float(comp_reg)
    assert float(train_reg) >= float(comp_reg)
    assert heads_reg["divergence"] >= 0.0
    assert set(heads_plain) == set(HEAD_WEIGHTS) | {"divergence"}


def test_bce_respects_pos_weight() -> None:
    logit = torch.zeros(1, 1, 1, 4)
    target = torch.tensor([[[[1.0, 0.0, 0.0, 0.0]]]])
    fluid = torch.ones(1, 1, 1, 4)
    low = float(masked_bce_with_logits(logit, target, fluid, 1.0))
    high = float(masked_bce_with_logits(logit, target, fluid, 20.0))
    assert high > low


def test_divergence_zero_on_uniform_flow() -> None:
    pred = torch.zeros(1, 6, 8, 8)
    pred[:, 0] = 1.0
    assert float(divergence_loss(pred)) == 0.0


def test_per_head_rmse_keys() -> None:
    pred, target, fluid = _batch()
    stds = {"meanU": 0.5, "meanV": 0.5, "cp": 1.0, "vorticity": 2.0, "tke": 1.0}
    out = per_head_rmse(pred, target, fluid, stds=stds)
    assert set(out) == {"meanU", "meanV", "cp", "vorticity", "tke", "recircAcc"}
    assert all(v >= 0.0 for v in out.values() if isinstance(v, float))
    assert 0.0 <= out["recircAcc"] <= 1.0
