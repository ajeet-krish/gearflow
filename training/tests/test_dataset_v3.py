"""V3 datasets: harmonic conversion, aux heads, norm pairs, sha gate."""

import json
from pathlib import Path

import numpy as np
import pytest
import torch

from dataset_v3 import (
    AnalyticV3Dataset,
    LbmV3Dataset,
    fit_norm_v3,
    normalize_sample_v3,
    with_refit_outputs_v3,
)


def _write_lbm_v3_fixture(root: Path, n_cases: int = 5, nx: int = 8, ny: int = 8) -> Path:
    sweep = root / "sweep"
    rng = np.random.default_rng(23)
    rows = []
    for c in range(n_cases):
        case_id = f"case_{c:03d}"
        case_dir = sweep / "cases" / case_id
        case_dir.mkdir(parents=True)
        yy, xx = np.mgrid[0:ny, 0:nx]
        obstacle = ((xx - nx // 2) ** 2 + (yy - ny // 2) ** 2 < 4).astype(np.float32)
        fluid = 1.0 - obstacle
        umean = np.full((ny, nx), 0.05, np.float32) * fluid
        vmean = rng.normal(0, 0.001, (ny, nx)).astype(np.float32) * fluid
        pmean = rng.normal(0, 0.0002, (ny, nx)).astype(np.float32)
        omegamean = rng.normal(0, 0.01, (ny, nx)).astype(np.float32) * fluid
        tke = (rng.random((ny, nx)).astype(np.float32) * 0.0001) * fluid
        recirc = ((umean < 0.0) * fluid).astype(np.float32)
        sdf = (np.sqrt((xx - nx // 2) ** 2 + (yy - ny // 2) ** 2) - 2.0).astype(np.float32)
        valid = (c % 2 == 0)
        if valid:
            ucos = rng.normal(0, 0.01, (ny, nx)).astype(np.float32) * fluid
            usin = rng.normal(0, 0.01, (ny, nx)).astype(np.float32) * fluid
            vcos = rng.normal(0, 0.008, (ny, nx)).astype(np.float32) * fluid
            vsin = rng.normal(0, 0.008, (ny, nx)).astype(np.float32) * fluid
        else:
            ucos = np.zeros((ny, nx), np.float32)
            usin = np.zeros((ny, nx), np.float32)
            vcos = np.zeros((ny, nx), np.float32)
            vsin = np.zeros((ny, nx), np.float32)
        bins = {
            "umean": umean,
            "vmean": vmean,
            "pmean": pmean,
            "omegamean": omegamean,
            "tke": tke,
            "recirc": recirc,
            "obstacle": obstacle,
            "sdf": sdf,
            "ucos": ucos,
            "usin": usin,
            "vcos": vcos,
            "vsin": vsin,
        }
        for name, arr in bins.items():
            arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
        rows.append(
            {
                "case_id": case_id,
                "body": "cylinder",
                "nx": nx,
                "ny": ny,
                "u_lattice": 0.05,
                "ref_length": 6.0,
                "alpha_deg": 4.0,
                "re": 200.0,
                "sha_version": 3,
                "harmonic_valid": valid,
                "strouhal": 0.2 if valid else None,
                "explained_variance": 0.8 if valid else 0.0,
                "harmonic_cycles": 5 if valid else 0,
                "harmonic_samples": 40 if valid else 0,
            }
        )
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return sweep


def _write_analytic_v3_fixture(root: Path, n_train: int = 3, n_val: int = 2) -> Path:
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
            {"id": sample_id, "split": split, "shard": 0, "index": k, "kind": "cylinder", "alpha": 4.0, "Re": 10000}
        )
    (root / "manifest.jsonl").write_text("\n".join(json.dumps(e) for e in manifest) + "\n")
    return data_dir


def test_v3_tuple_shapes_and_valid_weights(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path)
    train = LbmV3Dataset(sweep, "train")
    x, y, fluid, aux, aux_mask, weight = train[0]
    assert tuple(x.shape) == (4, 128, 128)
    assert tuple(y.shape) == (10, 128, 128)
    assert tuple(fluid.shape) == (1, 128, 128)
    assert tuple(aux.shape) == (3,)
    assert tuple(aux_mask.shape) == (3,)
    assert weight.shape == torch.Size([])
    assert bool(torch.isfinite(x).all()) and bool(torch.isfinite(y).all())
    for i in range(len(train)):
        _, _, _, _, mask, w = train[i]
        valid = bool(mask[0].item() > 0.5)
        assert float(w.item()) == pytest.approx(1.0 if valid else 0.05)
        if valid:
            assert float(mask[0].item()) == 1.0
        else:
            assert float(mask[0].item()) == 0.0
            assert float(mask[1].item()) == 1.0
            assert float(mask[2].item()) == 1.0


def test_v3_harmonic_conversion_exact_clip_solid(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=2, nx=8, ny=8)
    ds = LbmV3Dataset(sweep, "train")
    row = ds._rows[0]
    case_id = row["case_id"]
    nx, ny = int(row["nx"]), int(row["ny"])
    u_ref = float(row["u_lattice"])
    case_dir = sweep / "cases" / case_id
    raw_cos = np.fromfile(case_dir / "ucos.f32", dtype=np.float32).reshape(ny, nx)
    raw_sin = np.fromfile(case_dir / "usin.f32", dtype=np.float32).reshape(ny, nx)
    raw_x, raw_y, raw_aux, aux_mask, weight = ds._raw_sample(row)
    assert raw_y.shape == (10, 128, 128)
    assert harmonic_valid_of_row(raw_aux, aux_mask, weight)
    from dataset_v2 import resample_continuous

    with np.errstate(divide="ignore", invalid="ignore"):
        expect_cos = (raw_cos / np.float32(u_ref)).astype(np.float32)
    expect_cos[~np.isfinite(expect_cos)] = 0.0
    got_cos = raw_y[6]
    assert float(np.abs(got_cos).max()) <= 3.0 + 1e-6
    fluid = (raw_x[1] < 0.5).astype(np.float32)
    assert float(np.abs(got_cos[fluid < 0.5]).max()) == 0.0
    assert float(raw_aux[2]) == 1.0
    assert float(aux_mask[0]) == 1.0
    clipped = np.clip(resample_continuous(expect_cos), -3.0, 3.0) * fluid
    assert np.allclose(got_cos, clipped.astype(np.float32), atol=1e-5)


def harmonic_valid_of_row(raw_aux: np.ndarray, aux_mask: np.ndarray, weight: float) -> bool:
    return bool(aux_mask[0] > 0.5) and weight == pytest.approx(1.0) and float(raw_aux[2]) == 1.0


def test_v3_clip_and_solid_zeroing_on_extreme_bins(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=2, nx=8, ny=8)
    ds = LbmV3Dataset(sweep, "train")
    row = dict(ds._rows[0])
    case_dir = sweep / "cases" / row["case_id"]
    nx, ny = int(row["nx"]), int(row["ny"])
    big = np.full((ny, nx), 10.0, np.float32)
    big.tofile(case_dir / "ucos.f32")
    neg = np.full((ny, nx), -10.0, np.float32)
    neg.tofile(case_dir / "usin.f32")
    raw_x, raw_y, _, _, _ = ds._raw_sample(row)
    fluid = (raw_x[1] < 0.5).astype(np.float32)
    assert float(raw_y[6][fluid > 0.5].max()) == pytest.approx(3.0)
    assert float(raw_y[7][fluid > 0.5].min()) == pytest.approx(-3.0)
    assert float(np.abs(raw_y[6][fluid < 0.5]).max()) == 0.0
    assert float(np.abs(raw_y[7][fluid < 0.5]).max()) == 0.0


def test_v3_pair_std_equal_and_mean_zero(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path)
    train = LbmV3Dataset(sweep, "train")
    norm = train.norm
    for name in ("uCos", "uSin", "vCos", "vSin"):
        assert norm["outputs"][name]["mean"] == 0.0
    assert norm["outputs"]["uCos"]["std"] == norm["outputs"]["uSin"]["std"]
    assert norm["outputs"]["vCos"]["std"] == norm["outputs"]["vSin"]["std"]
    assert norm["outputs"]["uCos"]["std"] > 0.0
    assert norm["aux"]["strouhal"]["std"] > 0.0


def test_v3_analytic_degenerate_pairs_pinned(tmp_path) -> None:
    data_dir = _write_analytic_v3_fixture(tmp_path)
    train = AnalyticV3Dataset(data_dir, "train")
    x, y, fluid, aux, aux_mask, weight = train[0]
    assert tuple(y.shape) == (10, 128, 128)
    assert tuple(aux.shape) == (3,)
    assert float(weight.item()) == pytest.approx(0.05)
    assert float(aux_mask[0].item()) == 0.0
    assert float(aux_mask[1].item()) == 1.0
    assert float(aux_mask[2].item()) == 1.0
    assert bool((y[6:10] == 0.0).all())
    for name in ("uCos", "uSin", "vCos", "vSin"):
        entry = train.norm["outputs"][name]
        assert entry["mean"] == 0.0
        assert entry["std"] == 1.0
        assert entry["degenerate"] is True


def test_v3_sha_version_2_row_raises(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=2, nx=8, ny=8)
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    rows[0]["sha_version"] = 2
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    with pytest.raises(ValueError, match="sha_version"):
        LbmV3Dataset(sweep, "train")


def test_v3_split_reports_harmonic_counts(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=6)
    train = LbmV3Dataset(sweep, "train")
    val = LbmV3Dataset(sweep, "val", norm=train.norm)
    assert train.harmonic_counts["train"] == train.harmonic_train_count
    assert train.n_harmonic_valid == train.harmonic_counts["train"]
    total_valid = train.harmonic_counts["train"] + train.harmonic_counts["val"]
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    expect_valid = sum(1 for r in rows if bool(r.get("harmonic_valid")))
    assert total_valid == expect_valid
    assert val.harmonic_counts == train.harmonic_counts
    assert train.n_harmonic_valid == train.harmonic_counts["train"]
    assert val.n_harmonic_valid == val.harmonic_counts["val"]


def test_v3_fit_refit_keeps_inputs_frozen(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=4, nx=8, ny=8)
    train = LbmV3Dataset(sweep, "train")
    frozen = train.norm
    before = json.dumps(frozen["inputs"], sort_keys=True)
    raw_x, raw_y, raw_st = train._load_all_raw()
    refit = with_refit_outputs_v3(frozen, raw_x, raw_y, raw_st, fitted_on="lbm:test")
    assert json.dumps(refit["inputs"], sort_keys=True) == before
    assert json.dumps(frozen["inputs"], sort_keys=True) == before
    assert refit["outputs"]["uCos"]["std"] == refit["outputs"]["uSin"]["std"]


def test_v3_analytic_channel_order_recirc_fifth(tmp_path) -> None:
    from dataset_v3 import V3_OUT_HEADS

    assert V3_OUT_HEADS == (
        "meanU",
        "meanV",
        "cp",
        "vorticity",
        "tke",
        "recirc",
        "uCos",
        "uSin",
        "vCos",
        "vSin",
    )
    data_dir = _write_analytic_v3_fixture(tmp_path)
    shard = data_dir / "shard-000.npz"
    with np.load(shard) as z:
        blobs = {k: z[k] for k in z.files}
    first_key = sorted(blobs)[0]
    patched = blobs[first_key].copy()
    patched[3, 32:40, 32:40] = np.float32(-1.0)
    blobs[first_key] = patched
    np.savez(shard, **blobs)
    train = AnalyticV3Dataset(data_dir, "train")
    found_negative = False
    for entry in train._entries:
        raw_x, raw_y, _, _, _ = train._raw_sample(entry)
        assert raw_y.shape == (10, 128, 128)
        fluid = (raw_x[1] < 0.5).astype(np.float32)
        expect_recirc = ((raw_y[0] < 0.0) * fluid).astype(np.float32)
        assert np.array_equal(raw_y[5], expect_recirc), "channel 5 must equal the recirculation mask"
        assert bool((raw_y[6:10] == 0.0).all()), "harmonic channels 6-9 must stay zero for analytic rows"
        if bool((expect_recirc > 0.5).any()):
            found_negative = True
            assert bool((raw_y[5] > 0.5).any())
    assert found_negative, "fixture needs a negative-u cell to pin channel 5"


def test_v3_normalize_aux_values(tmp_path) -> None:
    sweep = _write_lbm_v3_fixture(tmp_path, n_cases=4, nx=8, ny=8)
    train = LbmV3Dataset(sweep, "train")
    valid_rows = [r for r in train._rows if bool(r.get("harmonic_valid"))]
    assert valid_rows
    raw_x, raw_y, raw_aux, _, _ = train._raw_sample(valid_rows[0])
    assert 0.0 <= float(raw_aux[1]) <= 1.0
    assert float(raw_aux[2]) == 1.0
    _, _, aux = normalize_sample_v3(raw_x, raw_y, raw_aux, train.norm)
    st = train.norm["aux"]["strouhal"]
    assert float(aux[0]) == pytest.approx((float(raw_aux[0]) - st["mean"]) / st["std"])
