"""V2 adapters: analytic and LBM fixtures, resampling, norm, sidecar."""

import json
from pathlib import Path

import numpy as np
import pytest
import torch

from dataset_v2 import (
    NORM_SCHEMA,
    AnalyticV2Dataset,
    LbmV2Dataset,
    canonical_norm_json,
    fit_norm,
    load_norm_sidecar,
    norm_hash,
    sdf_from_mask,
    split_case_ids,
    with_refit_outputs,
    write_norm_sidecar,
)


def _write_analytic_fixture(root: Path, n_train: int = 3, n_val: int = 2) -> Path:
    data_dir = root / "train"
    data_dir.mkdir(parents=True)
    entries = []
    rng = np.random.default_rng(11)
    for i in range(n_train + n_val):
        sample_id = f"s{i:05d}"
        split = "train" if i < n_train else "val"
        sdf = rng.normal(0, 1, (128, 128)).astype(np.float32)
        obstacle = np.zeros((128, 128), np.float32)
        obstacle[:16, :16] = 1.0
        alpha = np.full((128, 128), 4.0, np.float32)
        u = rng.normal(1, 0.2, (128, 128)).astype(np.float32)
        v = rng.normal(0, 0.1, (128, 128)).astype(np.float32)
        cp = rng.normal(0, 0.3, (128, 128)).astype(np.float32)
        stacked = np.stack([sdf, obstacle, alpha, u, v, cp])
        entries.append((sample_id, split, stacked))
    shard = data_dir / "shard-000.npz"
    np.savez(shard, **{f"{sample_id}.npy": stacked for sample_id, _, stacked in entries})
    manifest = []
    for k, (sample_id, split, _) in enumerate(entries):
        manifest.append(
            {
                "id": sample_id,
                "split": split,
                "shard": 0,
                "index": k,
                "kind": "cylinder",
                "alpha": 4.0,
                "Re": 10000,
            }
        )
    (root / "manifest.jsonl").write_text("\n".join(json.dumps(e) for e in manifest) + "\n")
    return data_dir


def test_analytic_adapter_shapes_and_channels(tmp_path) -> None:
    data_dir = _write_analytic_fixture(tmp_path)
    train = AnalyticV2Dataset(data_dir, "train")
    assert len(train) == 3
    x, y, fluid = train[0]
    assert tuple(x.shape) == (4, 128, 128)
    assert tuple(y.shape) == (6, 128, 128)
    assert tuple(fluid.shape) == (1, 128, 128)
    assert bool(torch.isfinite(x).all()) and bool(torch.isfinite(y).all())
    assert set(train.sdf_source.values()) == {"analytic"}
    val = AnalyticV2Dataset(data_dir, "val", norm=train.norm)
    assert len(val) == 2
    assert val.norm is train.norm


def test_analytic_tke_degenerate_and_solid_zeroed(tmp_path) -> None:
    data_dir = _write_analytic_fixture(tmp_path)
    train = AnalyticV2Dataset(data_dir, "train")
    tke = train.norm["outputs"]["tke"]
    assert tke["degenerate"] is True
    assert tke["std"] == 1.0
    assert train.norm["schema"] == NORM_SCHEMA
    raw_x, raw_y = train._raw_sample(train._entries[0])
    assert float(np.abs(raw_y[:, :16, :16]).max()) == 0.0
    fluid_raw = (raw_x[1] < 0.5).astype(np.float32)
    assert fluid_raw[:16, :16].sum() == 0.0
    assert fluid_raw[64:, 64:].sum() > 0.0


def test_analytic_missing_re_is_hard_error(tmp_path) -> None:
    data_dir = _write_analytic_fixture(tmp_path, n_train=2, n_val=1)
    rows = (tmp_path / "manifest.jsonl").read_text().splitlines()
    entry = json.loads(rows[0])
    del entry["Re"]
    rows[0] = json.dumps(entry)
    (tmp_path / "manifest.jsonl").write_text("\n".join(rows) + "\n")
    with pytest.raises(ValueError, match="[Rr]e"):
        AnalyticV2Dataset(data_dir, "train")


def _write_lbm_fixture(root: Path, n_cases: int = 5, nx: int = 16, ny: int = 16) -> Path:
    sweep = root / "sweep"
    rng = np.random.default_rng(23)
    rows = []
    for c in range(n_cases):
        case_id = f"case_{c:03d}"
        case_dir = sweep / "cases" / case_id
        case_dir.mkdir(parents=True)
        yy, xx = np.mgrid[0:ny, 0:nx]
        obstacle = ((xx - nx // 2) ** 2 + (yy - ny // 2) ** 2 < 9).astype(np.float32)
        umean = np.full((ny, nx), 0.05, np.float32) * (1.0 - obstacle)
        vmean = rng.normal(0, 0.001, (ny, nx)).astype(np.float32) * (1.0 - obstacle)
        pmean = rng.normal(0, 0.0002, (ny, nx)).astype(np.float32)
        omegamean = rng.normal(0, 0.01, (ny, nx)).astype(np.float32) * (1.0 - obstacle)
        tke = (rng.random((ny, nx)).astype(np.float32) * 0.0001) * (1.0 - obstacle)
        recirc = ((umean < 0.0) * (1.0 - obstacle)).astype(np.float32)
        sdf = (np.sqrt((xx - nx // 2) ** 2 + (yy - ny // 2) ** 2) - 3.0).astype(np.float32)
        bins = {
            "umean": umean,
            "vmean": vmean,
            "pmean": pmean,
            "omegamean": omegamean,
            "tke": tke,
            "recirc": recirc,
            "obstacle": obstacle,
            "sdf": sdf,
        }
        for name, arr in bins.items():
            if c == n_cases - 1 and name == "sdf":
                continue
            arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
        rows.append(
            {
                "case_id": case_id,
                "nx": nx,
                "ny": ny,
                "u_lattice": 0.05,
                "ref_length": 6.0,
                "alpha_deg": 4.0,
                "re": 2000,
            }
        )
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return sweep


def test_lbm_adapter_split_shapes_and_sources(tmp_path) -> None:
    sweep = _write_lbm_fixture(tmp_path)
    train_ids, val_ids = split_case_ids([f"case_{c:03d}" for c in range(5)])
    assert len(train_ids) == 4 and len(val_ids) == 1
    assert set(train_ids).isdisjoint(set(val_ids))
    train = LbmV2Dataset(sweep, "train")
    val = LbmV2Dataset(sweep, "val", norm=train.norm)
    assert len(train) == 4
    assert len(val) == 1
    assert val.sdf_source["case_004"] == "derived_mask"
    assert train.sdf_source["case_000"] == "lbm"
    x, y, fluid = train[0]
    assert tuple(x.shape) == (4, 128, 128)
    assert tuple(y.shape) == (6, 128, 128)
    assert tuple(fluid.shape) == (1, 128, 128)
    assert bool(torch.isfinite(x).all()) and bool(torch.isfinite(y).all())


def test_lbm_nondim_conversions(tmp_path) -> None:
    sweep = _write_lbm_fixture(tmp_path, n_cases=2, nx=8, ny=8)
    ds = LbmV2Dataset(sweep, "train")
    raw_x, raw_y = ds._load_all_raw()
    assert raw_y[0].shape == (6, 128, 128)
    assert float(np.abs(raw_y[0][0]).max()) > 0.0


def test_lbm_bad_ref_is_hard_error(tmp_path) -> None:
    sweep = _write_lbm_fixture(tmp_path, n_cases=2, nx=8, ny=8)
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    rows[0]["u_lattice"] = 0.0
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    with pytest.raises(ValueError, match="u_lattice"):
        LbmV2Dataset(sweep, "train")


def test_sidecar_roundtrip_and_refit(tmp_path) -> None:
    data_dir = _write_analytic_fixture(tmp_path)
    train = AnalyticV2Dataset(data_dir, "train")
    frozen_before = canonical_norm_json(train.norm)
    path = tmp_path / "norm.json"
    digest = write_norm_sidecar(path, train.norm)
    assert digest == norm_hash(train.norm)
    assert load_norm_sidecar(path)["schema"] == NORM_SCHEMA
    raw_targets = [train._raw_sample(e)[1] for e in train._entries]
    refit = with_refit_outputs(train.norm, raw_targets, fitted_on="lbm:test:train")
    assert canonical_norm_json(refit["inputs"]) == canonical_norm_json(train.norm["inputs"])
    assert canonical_norm_json(train.norm) == frozen_before
    assert refit["outputs"]["tke"]["degenerate"] is True


def test_fit_norm_rejects_mismatch() -> None:
    with pytest.raises(ValueError, match="matching"):
        fit_norm([], [])


def test_sdf_from_mask_sign_convention() -> None:
    """Derived SDF is negative inside solid, positive in fluid (v2 contract)."""
    mask = np.zeros((32, 32), dtype=np.float32)
    mask[12:20, 12:20] = 1.0
    sdf = sdf_from_mask(mask)
    assert sdf.shape == (32, 32)
    assert bool((sdf[mask > 0.5] < 0.0).all())
    assert bool((sdf[mask <= 0.5] > 0.0).all())


def test_cpu_smoke_one_epoch_pretrain(tmp_path) -> None:
    """One epoch over two synthetic samples on CPU proves the v2 stack runs."""
    import torch
    from torch.utils.data import DataLoader, Subset

    from losses import multihead_loss
    from model import UNetV2, param_count_v2

    data_dir = _write_analytic_fixture(tmp_path, n_train=2, n_val=1)
    train = AnalyticV2Dataset(data_dir, "train")
    loader = DataLoader(Subset(train, [0, 1]), batch_size=2, shuffle=False)
    model = UNetV2()
    assert sum(p.numel() for p in model.parameters()) == param_count_v2() == 122934
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    model.train()
    for x, y, fluid in loader:
        opt.zero_grad()
        loss, comp, _ = multihead_loss(model(x), y, fluid)
        assert bool(torch.isfinite(loss))
        loss.backward()
        opt.step()
    ckpt = {
        "arch": "unet-v2",
        "base": 8,
        "inCh": 4,
        "outCh": 6,
        "model": model.state_dict(),
        "norm": train.norm,
        "epoch": 0,
    }
    path = tmp_path / "best.pt"
    torch.save(ckpt, path)
    loaded = torch.load(path, map_location="cpu", weights_only=True)
    assert loaded["arch"] == "unet-v2" and int(loaded["base"]) == 8
