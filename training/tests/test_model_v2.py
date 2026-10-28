"""V2 model contract: 4 in, 6 out, base 8 locked, GroupNorm export."""

import pytest
import torch

from model import (
    IN_CH,
    OUT_CH,
    UNet,
    UNetV2,
    V2_BASE,
    V2_GN_EPS,
    V2_GROUPS,
    V2_IN_CH,
    V2_OUT_CH,
    param_count_v2,
)


def test_v1_untouched_and_importable() -> None:
    model = UNet()
    model.eval()
    with torch.no_grad():
        out = model(torch.zeros(1, IN_CH, 128, 128))
    assert out.shape == (1, OUT_CH, 128, 128)
    assert torch.isfinite(out).all()


def test_v2_forward_shapes() -> None:
    model = UNetV2()
    model.eval()
    with torch.no_grad():
        out = model(torch.zeros(1, V2_IN_CH, 128, 128))
    assert out.shape == (1, V2_OUT_CH, 128, 128)
    assert torch.isfinite(out).all()


def test_v2_param_count_locked() -> None:
    count = param_count_v2()
    actual = sum(p.numel() for p in UNetV2().parameters())
    assert actual == count == 122934
    assert abs(actual - 122934) / 122934 < 0.01


def test_v2_base_locked() -> None:
    with pytest.raises(ValueError, match="locked"):
        UNetV2(base=32)
    with pytest.raises(ValueError, match="locked"):
        UNetV2(base=16)


def test_v2_groupnorm_config() -> None:
    model = UNetV2()
    norms = [m for m in model.norms if not isinstance(m, torch.nn.Identity)]
    assert len(norms) == 14
    for norm in norms:
        assert norm.num_groups == V2_GROUPS == 4
        assert norm.eps == V2_GN_EPS == pytest.approx(1e-5)
        assert norm.affine is True
    assert isinstance(model.norms[-1], torch.nn.Identity)


def _export_v2_graph(tmp_path):  # type: ignore[no-untyped-def]
    onnx = pytest.importorskip("onnx", reason="onnx package absent, skipping v2 export check")
    from model import register_v2_onnx_symbolic

    register_v2_onnx_symbolic(18)
    model = UNetV2()
    model.eval()
    out_path = str(tmp_path / "v2.onnx")
    torch.onnx.export(
        model,
        torch.zeros(1, V2_IN_CH, 128, 128),
        out_path,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes=None,
        opset_version=18,
        dynamo=False,
    )
    return onnx.load(out_path).graph


def test_v2_export_has_groupnormalization(tmp_path) -> None:
    graph = _export_v2_graph(tmp_path)
    gn_nodes = [n for n in graph.node if n.op_type == "GroupNormalization"]
    assert len(gn_nodes) == 14
    for node in gn_nodes:
        attrs = {a.name: a for a in node.attribute}
        assert attrs["num_groups"].i == 4
        assert attrs["epsilon"].f == pytest.approx(1e-5)
    compute_ops = {n.op_type for n in graph.node} - {"Identity", "Constant", "Shape"}
    assert compute_ops <= {"Conv", "GroupNormalization", "Relu", "MaxPool", "Resize", "Concat"}


def _ort_runs_groupnorm() -> bool:
    try:
        import numpy as np
        import onnxruntime as ort
        from onnx import TensorProto, helper
    except ImportError:
        return False
    try:
        x = helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 8, 4, 4])
        y = helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 8, 4, 4])
        node = helper.make_node("GroupNormalization", ["X", "S", "B"], ["Y"], num_groups=4, epsilon=1e-5)
        graph = helper.make_graph(
            [node],
            "probe",
            [x],
            [y],
            [
                helper.make_tensor("S", TensorProto.FLOAT, [8], np.ones(8, np.float32)),
                helper.make_tensor("B", TensorProto.FLOAT, [8], np.zeros(8, np.float32)),
            ],
        )
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
        model.ir_version = 10
        sess = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
        sess.run(["Y"], {"X": np.zeros((1, 8, 4, 4), np.float32)})
        return True
    except Exception:
        return False


def test_v2_export_parity(tmp_path) -> None:
    pytest.importorskip("onnxruntime", reason="onnxruntime absent, skipping v2 parity check (C-5 owns the onnxruntime-web 1.30.0 proof)")
    if not _ort_runs_groupnorm():
        pytest.skip("onnxruntime in this env cannot execute GroupNormalization-18, skipping parity (C-5 owns the onnxruntime-web 1.30.0 proof)")
    import numpy as np
    import onnxruntime as ort

    graph = _export_v2_graph(tmp_path)
    onnx_path = str(tmp_path / "v2.onnx")
    model = UNetV2()
    model.eval()
    torch.manual_seed(7)
    probe = torch.randn(1, V2_IN_CH, 128, 128)
    with torch.no_grad():
        ref = model(probe).numpy()
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    got = sess.run(["output"], {"input": probe.numpy()})[0]
    assert got.shape == ref.shape
    assert float(np.max(np.abs(ref - got))) < 1e-4
    assert graph is not None
