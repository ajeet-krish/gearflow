"""V3 golden determinism, dual head parity, budgets, and the v2 round trip."""

import json

import numpy as np
import pytest
import torch

import make_golden
from dataset_v3 import empty_norm_v3
from export_onnx import ort_instancenorm_available
from make_golden import (
    GOLDEN_LBM_CASE,
    GOLDEN_V3_AVAILABLE_BUDGET,
    GOLDEN_V3_ONNX_CASES,
    GOLDEN_V3_SKIP_BUDGET,
    build_inputs_v3,
    load_bundle_v3,
    run_golden,
    run_golden_v3,
)
from model import UNetV2, UNetV3, V3_BASE


def synthetic_bundle_v3(seed=11):
    torch.manual_seed(seed)
    model = UNetV3(base=V3_BASE)
    norm = empty_norm_v3()
    norm["fittedOn"] = "synthetic"
    provenance = {"source": "synthetic", "detail": f"seeded random init (seed {seed})"}
    return model, norm, provenance


def run_synthetic_v3(out_dir, seed=11):
    model, norm, provenance = synthetic_bundle_v3(seed)
    return run_golden_v3(model, norm, provenance, out_dir, seed=seed)


def scrub_meta(golden: dict) -> dict:
    return {k: v for k, v in golden.items() if k not in ("generatedUtc", "totalBytes")}


def test_v3_golden_schema_heads_and_shapes(tmp_path) -> None:
    golden = run_synthetic_v3(tmp_path / "g")
    assert golden["schema"] == "gearflow-surrogate-golden/v2"
    assert golden["arch"] == "unet-v3"
    assert golden["base"] == V3_BASE == 8
    assert golden["opset"] == 18
    assert len(golden["spatialHeads"]) == 10
    assert list(golden["spatialHeads"]) == [
        "meanU", "meanV", "cp", "vorticity", "tke",
        "recirc", "uCos", "uSin", "vCos", "vSin",
    ]
    assert len(golden["auxHeads"]) == 3
    assert golden["inCh"] == 4 and golden["outCh"] == 10 and golden["auxCh"] == 3
    names = [c["name"] for c in golden["cases"]]
    assert names == ["zeros", "randn_s7", f"lbm_{GOLDEN_LBM_CASE}"]
    for case in golden["cases"]:
        assert case["input"]["shape"] == [1, 4, 128, 128]
        assert case["torchSpatial"]["shape"] == [1, 10, 128, 128]
        assert case["torchAux"]["shape"] == [1, 3]


def test_v3_golden_determinism_byte_identical(tmp_path) -> None:
    first = run_synthetic_v3(tmp_path / "a")
    second = run_synthetic_v3(tmp_path / "b")
    assert scrub_meta(first) == scrub_meta(second)
    for case in first["cases"]:
        for role in ("input", "torchSpatial", "torchAux"):
            a = (tmp_path / "a" / case[role]["file"]).read_bytes()
            b = (tmp_path / "b" / case[role]["file"]).read_bytes()
            assert a == b
    assert first["totalBytes"] == second["totalBytes"]


def test_v3_golden_budgets_explicit_and_recomputed(tmp_path) -> None:
    assert GOLDEN_V3_AVAILABLE_BUDGET == int(3.6 * 1024 * 1024)
    assert GOLDEN_V3_ONNX_CASES == ("zeros",)
    golden = run_synthetic_v3(tmp_path / "g")
    assert golden["onnxCases"] == ["zeros"]
    available, _ = ort_instancenorm_available()
    assert golden["onnx"]["available"] == available
    total = sum(p.stat().st_size for p in (tmp_path / "g").rglob("*") if p.is_file())
    assert total == golden["totalBytes"]
    one_input = 1 * 4 * 128 * 128 * 4
    one_spatial = 1 * 10 * 128 * 128 * 4
    one_aux = 1 * 3 * 4
    assert one_input == 262144
    assert one_spatial == 655360
    assert one_aux == 12
    persisted = 0
    for case in golden["cases"]:
        for role in ("input", "torchSpatial", "torchAux"):
            persisted += (tmp_path / "g" / case[role]["file"]).stat().st_size
    assert persisted == 3 * (one_input + one_spatial + one_aux)
    skip_files_total = persisted + (tmp_path / "g" / "golden.json").stat().st_size
    assert skip_files_total <= total
    if available:
        assert golden["totalBytes"] < GOLDEN_V3_AVAILABLE_BUDGET
        assert (tmp_path / "g" / "zeros" / "expected_onnx_spatial.f32").exists()
        assert (tmp_path / "g" / "zeros" / "expected_onnx_aux.f32").exists()
        assert golden["torchVsOnnxMaxErrSpatial"] is not None
        assert golden["torchVsOnnxMaxErrAux"] is not None
    else:
        assert golden["totalBytes"] < GOLDEN_V3_SKIP_BUDGET
        assert golden["totalBytes"] + one_spatial + one_aux < GOLDEN_V3_AVAILABLE_BUDGET
        assert golden["torchVsOnnxMaxErrSpatial"] is None
        assert golden["torchVsOnnxMaxErrAux"] is None


def test_v3_golden_available_path_writes_single_pair(tmp_path, monkeypatch) -> None:
    import sys
    import types

    monkeypatch.setattr(make_golden, "ort_instancenorm_available", lambda: (True, ""))
    monkeypatch.setattr("torch.onnx.export", lambda *a, **k: None)

    fake_ort = types.ModuleType("onnxruntime")
    zeros_spatial = np.zeros((1, 10, 128, 128), np.float32)
    zeros_aux = np.zeros((1, 3), np.float32)

    class FakeSession:
        def __init__(self, *a, **k) -> None:
            pass

        def run(self, names, inputs):
            assert names == ["output", "aux"]
            return [zeros_spatial, zeros_aux]

    fake_ort.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)

    model, norm, provenance = synthetic_bundle_v3()
    golden = make_golden.run_golden_v3(
        model, norm, provenance, tmp_path / "avail", seed=11, tolerance=1e9
    )
    assert golden["onnx"]["available"] is True
    assert golden["onnxCases"] == ["zeros"]
    assert golden["totalBytes"] < GOLDEN_V3_AVAILABLE_BUDGET
    assert (tmp_path / "avail" / "zeros" / "expected_onnx_spatial.f32").exists()
    assert (tmp_path / "avail" / "zeros" / "expected_onnx_aux.f32").exists()
    assert not (tmp_path / "avail" / "randn_s7" / "expected_onnx_spatial.f32").exists()
    assert not (tmp_path / "avail" / f"lbm_{GOLDEN_LBM_CASE}" / "expected_onnx_aux.f32").exists()
    for case in golden["cases"]:
        if case["name"] == "zeros":
            assert case["onnxSpatial"] is not None
            assert case["onnxSpatial"]["shape"] == [1, 10, 128, 128]
            assert case["onnxAux"] is not None
            assert case["onnxAux"]["shape"] == [1, 3]
        else:
            assert case["onnxSpatial"] is None
            assert case["onnxAux"] is None


def _precompute_torch_pairs(model, norm, seed):
    model.eval()
    cases = build_inputs_v3(norm, seed, GOLDEN_LBM_CASE, None)
    with torch.no_grad():
        pairs = []
        for case in cases:
            spatial, aux = model(torch.from_numpy(case["input"]))
            pairs.append(
                (spatial.numpy().astype(np.float32), aux.numpy().astype(np.float32))
            )
    return pairs


def test_v3_golden_parity_fails_on_spatial_only(tmp_path, monkeypatch) -> None:
    import sys
    import types

    model, norm, provenance = synthetic_bundle_v3(seed=13)
    pairs = _precompute_torch_pairs(model, norm, 13)
    bad_spatial = [(s + 1.0, a) for s, a in pairs]

    monkeypatch.setattr(make_golden, "ort_instancenorm_available", lambda: (True, ""))
    monkeypatch.setattr("torch.onnx.export", lambda *a, **k: None)
    fake_ort = types.ModuleType("onnxruntime")

    class FakeSession:
        def __init__(self, *a, **k) -> None:
            self.calls = 0

        def run(self, names, inputs):
            out = bad_spatial[self.calls]
            self.calls += 1
            return [out[0], out[1]]

    fake_ort.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    with pytest.raises(SystemExit, match="spatial"):
        make_golden.run_golden_v3(model, norm, provenance, tmp_path / "bad", seed=13)


def test_v3_golden_parity_fails_on_aux_only(tmp_path, monkeypatch) -> None:
    import sys
    import types

    model, norm, provenance = synthetic_bundle_v3(seed=17)
    pairs = _precompute_torch_pairs(model, norm, 17)
    bad_aux = [(s, a + 1.0) for s, a in pairs]

    monkeypatch.setattr(make_golden, "ort_instancenorm_available", lambda: (True, ""))
    monkeypatch.setattr("torch.onnx.export", lambda *a, **k: None)
    fake_ort = types.ModuleType("onnxruntime")

    class FakeSession:
        def __init__(self, *a, **k) -> None:
            self.calls = 0

        def run(self, names, inputs):
            out = bad_aux[self.calls]
            self.calls += 1
            return [out[0], out[1]]

    fake_ort.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    with pytest.raises(SystemExit, match="aux"):
        make_golden.run_golden_v3(model, norm, provenance, tmp_path / "bad", seed=17)


def test_load_bundle_v3_rejects_v2_and_v1(tmp_path) -> None:
    from dataset_v2 import empty_norm

    torch.manual_seed(3)
    v2_model = UNetV2()
    ckpt = {"arch": "unet-v2", "model": v2_model.state_dict(), "norm": empty_norm()}
    ckpt_path = tmp_path / "v2.pt"
    torch.save(ckpt, ckpt_path)
    norm_path = tmp_path / "norm.json"
    norm_path.write_text(json.dumps(empty_norm_v3()))
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
        load_bundle_v3(args)


def test_v2_golden_round_trip_still_passes(tmp_path) -> None:
    from dataset_v2 import empty_norm

    torch.manual_seed(11)
    model = UNetV2()
    norm = empty_norm()
    norm["fittedOn"] = "synthetic"
    provenance = {"source": "synthetic", "detail": "seeded"}
    golden = run_golden(model, norm, provenance, tmp_path / "g", seed=11)
    assert golden["schema"] == "gearflow-surrogate-golden/v1"
    assert golden["arch"] == "unet-v2"
    assert [c["name"] for c in golden["cases"]] == ["zeros", "randn_s7", f"lbm_{GOLDEN_LBM_CASE}"]
