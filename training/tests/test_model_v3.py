"""V3 model and loss: trunk parity, 10 plus 3 heads, count, masking."""

import pytest
import torch

from losses import divergence_loss_v3, multihead_loss_v3
from model import UNetV2, UNetV3, V3_ARCH, V3_AUX_CH, V3_OUT_CH, param_count_v3


def _batch(b: int = 2, h: int = 8, w: int = 8) -> tuple[
    torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor
]:
    torch.manual_seed(3)
    pred_spatial = torch.randn(b, 10, h, w)
    target_spatial = torch.randn(b, 10, h, w)
    target_spatial[:, 5] = (target_spatial[:, 5] > 0.0).float()
    pred_aux = torch.randn(b, 3)
    target_aux = torch.zeros(b, 3)
    target_aux[:, 1] = 0.7
    target_aux[:, 2] = 1.0
    aux_mask = torch.ones(b, 3)
    fluid = torch.ones(b, 1, h, w)
    fluid[:, :, :2, :2] = 0.0
    weight = torch.ones(b)
    return pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight


def test_v3_arch_constants() -> None:
    assert V3_ARCH == "unet-v3"
    assert V3_OUT_CH == 10
    assert V3_AUX_CH == 3


def test_v3_forward_shapes() -> None:
    model = UNetV3()
    model.eval()
    with torch.no_grad():
        spatial, aux = model(torch.zeros(1, 4, 128, 128))
    assert spatial.shape == (1, 10, 128, 128)
    assert aux.shape == (1, 3)
    assert bool(torch.isfinite(spatial).all()) and bool(torch.isfinite(aux).all())


def test_v3_param_count_locked() -> None:
    count = param_count_v3()
    actual = sum(p.numel() for p in UNetV3().parameters())
    assert actual == count == 123165
    with pytest.raises(ValueError, match="locked"):
        UNetV3(base=32)


def test_v3_trunk_matches_v2() -> None:
    v2 = UNetV2()
    v3 = UNetV3()
    assert len(v3.convs) == len(v2.convs) == 15
    for a, b in zip(v3.convs[:14], v2.convs[:14]):
        assert a.weight.shape == b.weight.shape
    assert v3.convs[14].out_channels == 10
    assert v2.convs[14].out_channels == 6
    assert v3.scalar.in_features == 64
    assert v3.scalar.out_features == 3


def test_v3_invalid_weight_scales_harmonic_only() -> None:
    pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, _ = _batch()
    valid = torch.ones(2)
    invalid = torch.full((2,), 0.05)
    _, sel_valid, heads_valid = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, valid
    )
    _, sel_invalid, heads_invalid = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, invalid
    )
    for name in ("uCos", "uSin", "vCos", "vSin"):
        assert heads_invalid[name] == pytest.approx(heads_valid[name] * 0.05, rel=1e-5)
    for name in ("meanU", "meanV", "cp", "vorticity", "tke", "recirc"):
        assert heads_invalid[name] == pytest.approx(heads_valid[name])
    assert float(sel_invalid) < float(sel_valid)


def test_v3_scalar_masking_hides_invalid_strouhal() -> None:
    pred_spatial, _, target_spatial, target_aux, _, fluid, weight = _batch(b=1)
    aux_mask = torch.tensor([[0.0, 1.0, 1.0]])
    base_aux = torch.zeros(1, 3)
    moved_aux = torch.tensor([[5.0, 0.0, 0.0]])
    train_base, _, _ = multihead_loss_v3(
        pred_spatial, base_aux, target_spatial, target_aux, aux_mask, fluid, weight
    )
    train_moved, _, _ = multihead_loss_v3(
        pred_spatial, moved_aux, target_spatial, target_aux, aux_mask, fluid, weight
    )
    assert float(train_base) == pytest.approx(float(train_moved))
    explained_moved = torch.tensor([[0.0, 5.0, 0.0]])
    train_expl, _, heads = multihead_loss_v3(
        pred_spatial, explained_moved, target_spatial, target_aux, aux_mask, fluid, weight
    )
    assert float(train_expl) != pytest.approx(float(train_base))
    assert heads["explained"] > 0.0


def test_v3_divergence_zero_on_clean_field() -> None:
    pred = torch.zeros(1, 10, 8, 8)
    pred[:, 0] = 1.0
    assert float(divergence_loss_v3(pred, 0.5, 0.4)) == 0.0
    pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight = _batch()
    train_plain, sel_plain, _ = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight, 0.5, 0.4, div_weight=0.0
    )
    train_reg, sel_reg, heads_reg = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight, 0.5, 0.4, div_weight=0.1
    )
    assert float(sel_plain) == float(sel_reg)
    assert float(train_reg) >= float(sel_reg)
    assert heads_reg["divergence"] >= 0.0
    assert train_plain.shape == torch.Size([])


def test_v3_loss_ignores_solid_cells() -> None:
    pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight = _batch()
    _, sel_full, _ = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight
    )
    perturbed = pred_spatial.clone()
    perturbed[:, :, :2, :2] = perturbed[:, :, :2, :2] + 5.0
    _, sel_perturbed, _ = multihead_loss_v3(
        perturbed, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight
    )
    assert float(sel_full) == pytest.approx(float(sel_perturbed))


def test_v3_metrics_present_when_targets_present() -> None:
    pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight = _batch()
    _, _, heads = multihead_loss_v3(
        pred_spatial, pred_aux, target_spatial, target_aux, aux_mask, fluid, weight
    )
    assert heads["uAmpRMSE"] >= 0.0
    assert heads["vAmpRMSE"] >= 0.0
    assert heads["uPhaseErr"] >= 0.0
    assert heads["vPhaseErr"] >= 0.0
    assert set(heads) >= {"uAmpRMSE", "vAmpRMSE", "uPhaseErr", "vPhaseErr", "divergence"}


def test_v3_cpu_smoke_one_step(tmp_path) -> None:
    import json

    import numpy as np

    sweep = tmp_path / "sweep"
    rng = np.random.default_rng(5)
    rows = []
    for c in range(4):
        case_id = f"case_{c:03d}"
        case_dir = sweep / "cases" / case_id
        case_dir.mkdir(parents=True)
        yy, xx = np.mgrid[0:8, 0:8]
        obstacle = ((xx - 4) ** 2 + (yy - 4) ** 2 < 4).astype(np.float32)
        fluid = 1.0 - obstacle
        bins = {
            "umean": (np.full((8, 8), 0.05, np.float32) * fluid),
            "vmean": (rng.normal(0, 0.001, (8, 8)).astype(np.float32) * fluid),
            "pmean": rng.normal(0, 0.0002, (8, 8)).astype(np.float32),
            "omegamean": (rng.normal(0, 0.01, (8, 8)).astype(np.float32) * fluid),
            "tke": ((rng.random((8, 8)).astype(np.float32) * 0.0001) * fluid),
            "recirc": np.zeros((8, 8), np.float32),
            "obstacle": obstacle,
            "sdf": (np.sqrt((xx - 4) ** 2 + (yy - 4) ** 2) - 2.0).astype(np.float32),
            "ucos": (rng.normal(0, 0.01, (8, 8)).astype(np.float32) * fluid),
            "usin": (rng.normal(0, 0.01, (8, 8)).astype(np.float32) * fluid),
            "vcos": (rng.normal(0, 0.008, (8, 8)).astype(np.float32) * fluid),
            "vsin": (rng.normal(0, 0.008, (8, 8)).astype(np.float32) * fluid),
        }
        for name, arr in bins.items():
            arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
        rows.append(
            {
                "case_id": case_id,
                "body": "block",
                "nx": 8,
                "ny": 8,
                "u_lattice": 0.05,
                "ref_length": 6.0,
                "alpha_deg": 0.0,
                "re": 300.0,
                "sha_version": 3,
                "harmonic_valid": True,
                "strouhal": 0.18,
                "explained_variance": 0.7,
                "harmonic_cycles": 4,
                "harmonic_samples": 32,
            }
        )
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    from torch.utils.data import DataLoader

    from dataset_v3 import LbmV3Dataset

    train = LbmV3Dataset(sweep, "train")
    loader = DataLoader(train, batch_size=2, shuffle=False)
    model = UNetV3()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    model.train()
    for x, y, fluid_m, aux, aux_mask, w in loader:
        opt.zero_grad()
        pred_spatial, pred_aux = model(x)
        loss, _, _ = multihead_loss_v3(pred_spatial, pred_aux, y, aux, aux_mask, fluid_m, w)
        assert bool(torch.isfinite(loss))
        loss.backward()
        opt.step()
