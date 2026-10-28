"""V3 export branch: two outputs, manifest heads, mismatch refusal, capability."""

import hashlib
import json

import pytest
import torch

from dataset_v3 import canonical_norm_json_v3, empty_norm_v3, norm_hash_v3
from export_onnx import (
    V3_AUX_HEADS,
    V3_NORM_SCHEMA,
    V3_SPATIAL_HEADS,
    export_v2,
    export_v3,
    ort_instancenorm_available,
)
from model import (
    V2_ARCH,
    V2_BASE,
    V2_IN_CH,
    V2_OUT_CH,
    V3_ARCH,
    V3_AUX_CH,
    V3_BASE,
    V3_IN_CH,
    V3_OUT_CH,
    UNetV2,
    UNetV3,
)


def write_v3_sidecar(path, norm):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_norm_json_v3(norm))
    return norm_hash_v3(norm)


def make_v3_bundle(tmp_path, seed=11, run_id="test-run-v3", capable=True):
    torch.manual_seed(seed)
    model = UNetV3(base=V3_BASE)
    norm = empty_norm_v3()
    norm["fittedOn"] = "synthetic-test"
    if capable:
        norm["nFit"] = 8
        norm["aux"]["fitCount"] = 8
    ckpt = {
        "arch": V3_ARCH,
        "base": V3_BASE,
        "inCh": V3_IN_CH,
        "outCh": V3_OUT_CH,
        "auxCh": V3_AUX_CH,
        "model": model.state_dict(),
        "norm": norm,
        "epoch": 0,
        "stage": "test",
        "runId": run_id,
    }
    ckpt_path = tmp_path / "best.pt"
    torch.save(ckpt, ckpt_path)
    norm_path = tmp_path / "norm.json"
    write_v3_sidecar(norm_path, norm)
    return ckpt_path, norm_path


def test_v3_export_two_outputs_shapes_manifest_and_copy(tmp_path) -> None:
    ckpt_path, norm_path = make_v3_bundle(tmp_path)
    out_dir = tmp_path / "v3out"
    manifest = export_v3(ckpt_path, norm_path, out_dir, run_id="test-run-v3")

    onnx_path = out_dir / "model.onnx"
    assert onnx_path.exists()
    onnx = pytest.importorskip("onnx", reason="onnx package absent, skipping graph check")
    graph = onnx.load(str(onnx_path)).graph
    dims = {i.name: [d.dim_value for d in i.type.tensor_type.shape.dim] for i in graph.input}
    assert dims["input"] == [1, V3_IN_CH, 128, 128]
    names = [o.name for o in graph.output]
    assert names == ["output", "aux"]
    out_dims = {o.name: [d.dim_value for d in o.type.tensor_type.shape.dim] for o in graph.output}
    assert out_dims["output"][1] == V3_OUT_CH
    assert out_dims["output"][0] in (0, 1)
    assert out_dims["output"][2:] == [128, 128] or all(v == 0 for v in out_dims["output"][2:])
    assert out_dims["aux"][1] == V3_AUX_CH
    opsets = {o.domain or "ai.onnx": o.version for o in onnx.load(str(onnx_path)).opset_import}
    assert opsets.get("ai.onnx", opsets.get("", None)) == 18
    with torch.no_grad():
        probe = torch.zeros(1, V3_IN_CH, 128, 128)
        ckpt_reload = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        check = UNetV3(base=V3_BASE)
        check.load_state_dict(ckpt_reload["model"])
        check.eval()
        spatial, aux = check(probe)
        assert list(spatial.shape) == [1, V3_OUT_CH, 128, 128]
        assert list(aux.shape) == [1, V3_AUX_CH]
    in_nodes = [n for n in graph.node if n.op_type == "InstanceNormalization"]
    assert len(in_nodes) == 14
    assert not any(n.op_type == "GroupNormalization" for n in graph.node)

    assert manifest["version"] == "3"
    assert manifest["arch"] == V3_ARCH
    assert manifest["base"] == V3_BASE == 8
    assert manifest["inCh"] == V3_IN_CH and manifest["outCh"] == V3_OUT_CH
    assert manifest["auxCh"] == V3_AUX_CH
    assert list(manifest["spatialHeads"]) == list(V3_SPATIAL_HEADS)
    assert len(manifest["spatialHeads"]) == 10
    assert list(manifest["auxHeads"]) == list(V3_AUX_HEADS)
    assert len(manifest["auxHeads"]) == 3
    assert manifest["normSchema"] == V3_NORM_SCHEMA == "gearflow-surrogate-norm/v3"
    assert manifest["harmonicCapable"] is True
    assert manifest["opset"] == 18
    assert manifest["runId"] == "test-run-v3"
    for role in ("model", "norm"):
        entry = manifest["files"][role]
        actual = hashlib.sha256((out_dir / entry["path"]).read_bytes()).hexdigest()
        assert entry["sha256"] == actual
    assert manifest["files"]["norm"]["sha256"] == manifest["normSha256"]
    assert (out_dir / "norm.json").read_bytes() == norm_path.read_bytes()
    on_disk = json.loads((out_dir / "model.json").read_text())
    assert on_disk == manifest

    available, _ = ort_instancenorm_available()
    parity = manifest["provenance"]["parity"]
    assert parity["status"] in ("pass", "skipped")
    if available:
        assert parity["status"] == "pass"
        assert parity["maxErrSpatial"] is not None and parity["maxErrSpatial"] < 1e-4
        assert parity["maxErrAux"] is not None and parity["maxErrAux"] < 1e-4
    else:
        assert parity["status"] == "skipped"
        assert parity["reason"] != ""


def test_v3_export_refuses_v2_checkpoint(tmp_path) -> None:
    torch.manual_seed(5)
    model = UNetV2(base=V2_BASE)
    from dataset_v2 import empty_norm, write_norm_sidecar

    norm = empty_norm()
    ckpt = {
        "arch": V2_ARCH,
        "base": V2_BASE,
        "inCh": V2_IN_CH,
        "outCh": V2_OUT_CH,
        "model": model.state_dict(),
        "norm": norm,
        "runId": "v2-ckpt",
    }
    ckpt_path = tmp_path / "v2.pt"
    torch.save(ckpt, ckpt_path)
    v3_norm = empty_norm_v3()
    v3_norm["fittedOn"] = "synthetic-test"
    norm_path = tmp_path / "norm.json"
    write_v3_sidecar(norm_path, v3_norm)
    with pytest.raises(SystemExit, match="refusing"):
        export_v3(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_refuses_v3_checkpoint(tmp_path) -> None:
    ckpt_path, norm_path = make_v3_bundle(tmp_path)
    with pytest.raises(SystemExit, match="refusing"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v3_harmonic_capability_false_when_aux_fit_zero(tmp_path) -> None:
    ckpt_path, norm_path = make_v3_bundle(tmp_path, capable=False)
    manifest = export_v3(ckpt_path, norm_path, tmp_path / "out", run_id="test-run-v3")
    assert manifest["harmonicCapable"] is False


def test_v3_harmonic_capability_false_when_checkpoint_disables(tmp_path) -> None:
    ckpt_path, norm_path = make_v3_bundle(tmp_path, capable=True)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    ckpt["harmonicCapable"] = False
    torch.save(ckpt, ckpt_path)
    manifest = export_v3(ckpt_path, norm_path, tmp_path / "out", run_id="test-run-v3")
    assert manifest["harmonicCapable"] is False


def test_v2_round_trip_still_passes_unchanged(tmp_path) -> None:
    from dataset_v2 import empty_norm, write_norm_sidecar

    torch.manual_seed(11)
    model = UNetV2(base=V2_BASE)
    norm = empty_norm()
    norm["fittedOn"] = "synthetic-test"
    ckpt = {
        "arch": V2_ARCH,
        "base": V2_BASE,
        "inCh": V2_IN_CH,
        "outCh": V2_OUT_CH,
        "model": model.state_dict(),
        "norm": norm,
        "epoch": 0,
        "stage": "test",
        "runId": "test-run",
    }
    ckpt_path = tmp_path / "best.pt"
    torch.save(ckpt, ckpt_path)
    norm_path = tmp_path / "norm.json"
    write_norm_sidecar(norm_path, norm)
    manifest = export_v2(ckpt_path, norm_path, tmp_path / "v2out", run_id="test-run")
    assert manifest["version"] == "2"
    assert manifest["arch"] == V2_ARCH
    assert (tmp_path / "v2out" / "model.onnx").exists()
