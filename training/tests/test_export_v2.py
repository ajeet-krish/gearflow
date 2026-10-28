"""V2 export branch: shapes, manifest, sha agreement, v1 rejection."""

import hashlib
import json

import pytest
import torch

from dataset_v2 import empty_norm, norm_hash, write_norm_sidecar
from export_onnx import export_v2, ort_instancenorm_available
from model import V2_ARCH, V2_BASE, V2_IN_CH, V2_OUT_CH, UNet, UNetV2


def make_v2_bundle(tmp_path, seed=11, run_id="test-run"):
    torch.manual_seed(seed)
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
        "runId": run_id,
    }
    ckpt_path = tmp_path / "best.pt"
    torch.save(ckpt, ckpt_path)
    norm_path = tmp_path / "norm.json"
    write_norm_sidecar(norm_path, norm)
    return ckpt_path, norm_path


def test_v2_export_shapes_manifest_and_copy(tmp_path) -> None:
    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    out_dir = tmp_path / "v2out"
    manifest = export_v2(ckpt_path, norm_path, out_dir, run_id="test-run")

    onnx_path = out_dir / "model.onnx"
    assert onnx_path.exists()
    onnx = pytest.importorskip("onnx", reason="onnx package absent, skipping graph check")
    graph = onnx.load(str(onnx_path)).graph
    dims = {i.name: [d.dim_value for d in i.type.tensor_type.shape.dim] for i in graph.input}
    assert dims["input"] == [1, V2_IN_CH, 128, 128]
    out_dims = {o.name: [d.dim_value for d in o.type.tensor_type.shape.dim] for o in graph.output}
    out_params = {o.name: [d.dim_param for d in o.type.tensor_type.shape.dim] for o in graph.output}
    assert len(out_dims["output"]) == 4
    assert out_dims["output"][1] == V2_OUT_CH
    # TorchScript export records the output batch/spatial dims symbolically
    # (dim_value 0 with a Convoutput_dim_* param), so concrete fixed shapes
    # are pinned on the input graph plus a real torch forward below, not on
    # output dim_value entries which are never concrete from this exporter.
    assert out_dims["output"][0] in (0, 1)
    assert out_dims["output"][2:] == [128, 128] or all(v == 0 for v in out_dims["output"][2:])
    opsets = {o.domain or "ai.onnx": o.version for o in onnx.load(str(onnx_path)).opset_import}
    assert opsets.get("ai.onnx", opsets.get("", None)) == 18
    with torch.no_grad():
        probe = torch.zeros(1, V2_IN_CH, 128, 128)
        ckpt_reload = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        from model import UNetV2 as _V2

        _m = _V2(base=V2_BASE)
        _m.load_state_dict(ckpt_reload["model"])
        _m.eval()
        assert list(_m(probe).shape) == [1, V2_OUT_CH, 128, 128]
    in_nodes = [n for n in graph.node if n.op_type == "InstanceNormalization"]
    assert len(in_nodes) == 14
    assert not any(n.op_type == "GroupNormalization" for n in graph.node)

    assert manifest["version"] == "2"
    assert manifest["arch"] == V2_ARCH
    assert manifest["base"] == V2_BASE == 8
    assert manifest["inCh"] == V2_IN_CH and manifest["outCh"] == V2_OUT_CH
    assert manifest["opset"] == 18
    assert manifest["runId"] == "test-run"
    assert manifest["normSha256"] == norm_hash(empty_norm_with_fitted_on())
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
        assert parity["maxErr"] is not None and parity["maxErr"] < 1e-4
    else:
        assert parity["status"] == "skipped"
        assert parity["reason"] != ""


def empty_norm_with_fitted_on():
    norm = empty_norm()
    norm["fittedOn"] = "synthetic-test"
    return norm


def test_v2_export_refuses_v1_checkpoint(tmp_path) -> None:
    model = UNet(base=8)
    ckpt = {"model": model.state_dict(), "norm": {"sdfMean": 0.0}, "base": 8, "epoch": 0}
    ckpt_path = tmp_path / "v1.pt"
    torch.save(ckpt, ckpt_path)
    norm = empty_norm()
    norm_path = tmp_path / "norm.json"
    write_norm_sidecar(norm_path, norm)
    with pytest.raises(SystemExit, match="refusing"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_norm_mismatch(tmp_path) -> None:
    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    other = empty_norm()
    other["fittedOn"] = "tampered"
    write_norm_sidecar(norm_path, other)
    with pytest.raises(SystemExit, match="[Hh]ash mismatch"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_rejects_groupnorm_sidecar(tmp_path) -> None:
    import json

    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    other = empty_norm()
    other["fittedOn"] = "synthetic-test"
    other["normalization"] = {"operator": "GroupNormalization", "groups": 4, "eps": 1e-5}
    norm_path.write_text(json.dumps(other))
    with pytest.raises(ValueError, match="normalization"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_write_sidecar_rejects_groupnorm_operator(tmp_path) -> None:
    norm = empty_norm()
    norm["normalization"] = {"operator": "GroupNormalization", "groups": 4, "eps": 1e-5}
    with pytest.raises(ValueError, match="normalization"):
        write_norm_sidecar(tmp_path / "norm.json", norm)


def test_v2_export_rejects_wrong_base(tmp_path) -> None:
    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    ckpt["base"] = 16
    torch.save(ckpt, ckpt_path)
    with pytest.raises(SystemExit, match="locked"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_rejects_wrong_in_ch(tmp_path) -> None:
    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    ckpt["inCh"] = V2_IN_CH + 1
    torch.save(ckpt, ckpt_path)
    with pytest.raises(SystemExit, match="channels must"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_rejects_wrong_out_ch(tmp_path) -> None:
    ckpt_path, norm_path = make_v2_bundle(tmp_path)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    ckpt["outCh"] = V2_OUT_CH + 1
    torch.save(ckpt, ckpt_path)
    with pytest.raises(SystemExit, match="channels must"):
        export_v2(ckpt_path, norm_path, tmp_path / "out")


def test_v2_export_needs_no_custom_symbolic(tmp_path) -> None:
    """InstanceNormalization exports natively: no custom symbolic registered."""
    model = UNetV2()
    model.eval()
    out_path = str(tmp_path / "v2.onnx")
    torch.onnx.export(
        model,
        torch.zeros(1, V2_IN_CH, 32, 32),
        out_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes=None,
        opset_version=18,
        dynamo=False,
    )
    onnx = pytest.importorskip("onnx", reason="onnx package absent")
    graph = onnx.load(out_path).graph
    assert any(n.op_type == "InstanceNormalization" for n in graph.node)
    assert not any(n.op_type == "GroupNormalization" for n in graph.node)
