"""V2 golden determinism, budget, and the ORT skip or parity path."""

import json

import numpy as np
import pytest
import torch

from dataset_v2 import empty_norm
from export_onnx import ort_instancenorm_available
from make_golden import (
    GOLDEN_AVAILABLE_BUDGET,
    GOLDEN_BUDGET,
    GOLDEN_LBM_CASE,
    GOLDEN_ONNX_CASES,
    load_bundle,
    run_golden,
)
from model import UNetV2, V2_BASE


def synthetic_bundle(seed=11):
    torch.manual_seed(seed)
    model = UNetV2(base=V2_BASE)
    norm = empty_norm()
    norm["fittedOn"] = "synthetic"
    provenance = {"source": "synthetic", "detail": f"seeded random init (seed {seed})"}
    return model, norm, provenance


def run_synthetic(out_dir, seed=11):
    model, norm, provenance = synthetic_bundle(seed)
    return run_golden(model, norm, provenance, out_dir, seed=seed)


def scrub_meta(golden: dict) -> dict:
    cleaned = {k: v for k, v in golden.items() if k not in ("generatedUtc", "totalBytes")}
    return cleaned


def test_golden_determinism_same_seed_byte_identical(tmp_path) -> None:
    first = run_synthetic(tmp_path / "a")
    second = run_synthetic(tmp_path / "b")
    assert scrub_meta(first) == scrub_meta(second)
    for case in first["cases"]:
        for role in ("input", "torch"):
            a = (tmp_path / "a" / case[role]["file"]).read_bytes()
            b = (tmp_path / "b" / case[role]["file"]).read_bytes()
            assert a == b
        assert case["input"]["shape"] == [1, 4, 128, 128]
        assert case["torch"]["shape"] == [1, 6, 128, 128]
    names = [c["name"] for c in first["cases"]]
    assert names == ["zeros", "randn_s7", f"lbm_{GOLDEN_LBM_CASE}"]
    assert all(c["description"] for c in first["cases"])
    assert first["normSha256"] == second["normSha256"]
    assert first["totalBytes"] == second["totalBytes"]
    assert first["base"] == V2_BASE == 8
    assert first["opset"] == 18


def test_golden_total_under_budget(tmp_path) -> None:
    golden = run_synthetic(tmp_path / "g")
    assert GOLDEN_BUDGET == 2 * 1024 * 1024
    assert GOLDEN_ONNX_CASES == ("zeros",)
    assert golden["onnxCases"] == ["zeros"]
    available, _ = ort_instancenorm_available()
    assert golden["onnx"]["available"] == available
    total = sum(p.stat().st_size for p in (tmp_path / "g").rglob("*") if p.is_file())
    assert total == golden["totalBytes"]
    one_onnx = 1 * 6 * 128 * 128 * 4
    assert one_onnx == 393216
    if available:
        assert golden["totalBytes"] < GOLDEN_AVAILABLE_BUDGET
        assert (tmp_path / "g" / "zeros" / "expected_onnx.f32").exists()
    else:
        assert golden["totalBytes"] < GOLDEN_BUDGET
        assert golden["totalBytes"] + one_onnx < GOLDEN_AVAILABLE_BUDGET


def test_golden_available_path_writes_single_onnx(tmp_path, monkeypatch) -> None:
    import sys
    import types

    import make_golden

    monkeypatch.setattr(make_golden, "ort_instancenorm_available", lambda: (True, ""))
    monkeypatch.setattr("torch.onnx.export", lambda *a, **k: None)

    fake_ort = types.ModuleType("onnxruntime")
    zeros_out = np.zeros((1, 6, 128, 128), np.float32)

    class FakeSession:
        def __init__(self, *a, **k) -> None:
            pass

        def run(self, names, inputs):
            return [zeros_out]

    fake_ort.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)

    model, norm, provenance = synthetic_bundle()
    golden = make_golden.run_golden(
        model, norm, provenance, tmp_path / "avail", seed=11, tolerance=1e9
    )
    assert golden["onnx"]["available"] is True
    assert golden["onnxCases"] == ["zeros"]
    assert golden["totalBytes"] < GOLDEN_AVAILABLE_BUDGET
    assert (tmp_path / "avail" / "zeros" / "expected_onnx.f32").exists()
    assert not (tmp_path / "avail" / "randn_s7" / "expected_onnx.f32").exists()
    assert not (tmp_path / "avail" / f"lbm_{GOLDEN_LBM_CASE}" / "expected_onnx.f32").exists()
    for case in golden["cases"]:
        if case["name"] == "zeros":
            assert case["onnx"] is not None
            assert case["onnx"]["shape"] == [1, 6, 128, 128]
        else:
            assert case["onnx"] is None


def test_golden_onnx_skip_or_parity(tmp_path) -> None:
    golden = run_synthetic(tmp_path / "g")
    available, _ = ort_instancenorm_available()
    assert golden["onnx"]["available"] == available
    if available:
        assert golden["torchVsOnnxMaxErr"] is not None
        assert golden["torchVsOnnxMaxErr"] < 1e-4
        for case in golden["cases"]:
            if case["name"] in ("zeros",):
                assert case["onnx"] is not None
                torch_arr = np.fromfile(tmp_path / "g" / case["torch"]["file"], dtype=np.float32)
                onnx_arr = np.fromfile(tmp_path / "g" / case["onnx"]["file"], dtype=np.float32)
                assert torch_arr.shape == onnx_arr.shape == (1 * 6 * 128 * 128,)
                assert float(np.max(np.abs(torch_arr - onnx_arr))) < 1e-4
            else:
                assert case["onnx"] is None
                assert not (tmp_path / "g" / case["name"] / "expected_onnx.f32").exists()
    else:
        assert golden["torchVsOnnxMaxErr"] is None
        assert golden["onnx"]["reason"] != ""
        for case in golden["cases"]:
            assert case["onnx"] is None
            assert not (tmp_path / "g" / case["name"] / "expected_onnx.f32").exists()
            arr = np.fromfile(tmp_path / "g" / case["torch"]["file"], dtype=np.float32)
            assert arr.shape == (1 * 6 * 128 * 128,)
            assert bool(np.all(np.isfinite(arr)))


def test_golden_lbm_case_uses_real_adapter(tmp_path) -> None:
    golden = run_synthetic(tmp_path / "g")
    lbm = [c for c in golden["cases"] if c["name"].startswith("lbm_")][0]
    assert lbm["lbmCase"] == GOLDEN_LBM_CASE
    assert lbm["refLength"] == pytest.approx(1.0)
    assert lbm["sdfSource"] == "derived_mask"
    raw = np.fromfile(tmp_path / "g" / lbm["input"]["file"], dtype=np.float32)
    assert raw.shape == (1 * 4 * 128 * 128,)
    assert bool(np.all(np.isfinite(raw)))
    assert float(np.abs(raw).max()) > 0.0


def test_load_bundle_rejects_v1(tmp_path) -> None:
    from model import UNet

    ckpt = {"model": UNet(base=8).state_dict(), "norm": {}, "base": 8}
    ckpt_path = tmp_path / "v1.pt"
    torch.save(ckpt, ckpt_path)
    norm_path = tmp_path / "norm.json"
    norm_path.write_text(json.dumps(empty_norm()))
    args = type(
        "Args",
        (),
        {
            "synthetic": False,
            "checkpoint": ckpt_path,
            "norm": norm_path,
            "run_id": None,
            "seed": 11,
        },
    )()
    with pytest.raises(SystemExit, match="refusing"):
        load_bundle(args)
