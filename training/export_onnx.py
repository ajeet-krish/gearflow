"""ONNX export plus browser manifest. Run by the user after training.

v1 usage (unchanged):
    uv run --project training python export_onnx.py
Reads training/checkpoints/best.pt, exports opset 18 with batch 1, runs a
Python parity check (torch vs onnxruntime on a fixed seed input), writes
public/surrogate/model.json (shapes, norm stats, SHA256) and
public/surrogate/weights.bin (Float32 params in TS forward order).

v2 usage:
    uv run --project training python export_onnx.py --run-id <run_id>
Reads training/checkpoints/v2/<run_id>/best.pt plus the norm.json sidecar,
asserts sidecar hash agreement, exports opset 18 with fixed batch 1 and
fixed 128 by 128 (no dynamic axes), writes public/surrogate/v2/model.onnx
plus a norm.json byte copy plus a model.json browser manifest (version 2,
arch, base 8, channels, opset 18, files plus sha256, runId, provenance).
Sigmoid and expm1 stay in the TypeScript consumer, never in the ONNX graph.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from model import (
    IN_CH,
    OUT_CH,
    V2_ARCH,
    V2_BASE,
    V2_IN_CH,
    V2_OUT_CH,
    UNet,
    UNetV2,
    param_count,
    param_count_v2,
)

HERE = Path(__file__).parent
CHECKPOINT = HERE / "checkpoints" / "best.pt"
OUT_DIR = HERE.parent / "public" / "surrogate"
V2_CHECKPOINT_ROOT = HERE / "checkpoints" / "v2"
V2_OUT_DIR = HERE.parent / "public" / "surrogate" / "v2"
NX = 128
NY = 128
V2_OPSET = 18
V2_TOLERANCE = 1e-4

V2_SKIP_HINT = "local ORT limitation, onnxruntime-web 1.30.0 proof in src/flow/surrogateV2.test.ts"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_checkpoint(path: Path) -> dict:
    return torch.load(path, map_location="cpu", weights_only=True)


def ort_instancenorm_available() -> tuple[bool, str]:
    """Probe whether this env ORT build can execute InstanceNormalization-18.

    Returns (True, "") when a tiny InstanceNormalization graph runs, else
    (False, reason). onnxruntime-web 1.30.0 executes the op (proven by the
    live probe in src/flow/surrogateV2.test.ts); some local CPU builds may
    still fail, so callers record a skip instead of failing closed on this
    probe alone.
    """
    try:
        import onnxruntime as ort
        from onnx import TensorProto, helper
    except ImportError as exc:
        return False, f"onnxruntime probe unavailable ({exc}); {V2_SKIP_HINT}"
    try:
        x = helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 8, 4, 4])
        y = helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 8, 4, 4])
        node = helper.make_node(
            "InstanceNormalization", ["X", "S", "B"], ["Y"], epsilon=1e-5
        )
        graph = helper.make_graph(
            [node],
            "in-probe",
            [x],
            [y],
            [
                helper.make_tensor("S", TensorProto.FLOAT, [8], np.ones(8, np.float32)),
                helper.make_tensor("B", TensorProto.FLOAT, [8], np.zeros(8, np.float32)),
            ],
        )
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", V2_OPSET)])
        model.ir_version = 10
        sess = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
        sess.run(["Y"], {"X": np.zeros((1, 8, 4, 4), np.float32)})
        return True, ""
    except Exception as exc:
        return False, f"onnxruntime in this env cannot execute InstanceNormalization-18 ({exc}); {V2_SKIP_HINT}"


def check_v2_parity(model: torch.nn.Module, onnx_path: Path) -> dict:
    """Torch vs ORT parity on a seeded probe; fail closed on real mismatch.

    When ORT cannot execute InstanceNormalization in this env, returns a
    skipped record instead of raising, so export still writes artifacts
    with honest provenance.
    """
    import onnxruntime as ort

    torch.manual_seed(7)
    probe = torch.randn(1, V2_IN_CH, NY, NX)
    with torch.no_grad():
        ref = model(probe).numpy()
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    got = sess.run(["output"], {"input": probe.numpy()})[0]
    if got.shape != ref.shape:
        raise SystemExit(f"export: v2 parity shape {got.shape} != torch {ref.shape}")
    max_err = float(np.max(np.abs(ref - got)))
    print(f"export: v2 parity max_err={max_err:.3e}")
    if not np.isfinite(max_err) or max_err > V2_TOLERANCE:
        raise SystemExit(f"export: v2 parity check failed (max_err={max_err})")
    return {"status": "pass", "maxErr": max_err}


def export_v1(checkpoint: Path = CHECKPOINT, out_dir: Path = OUT_DIR) -> None:
    if not checkpoint.exists():
        raise SystemExit(f"export: checkpoint missing: {checkpoint} (train first)")
    ckpt = load_checkpoint(checkpoint)
    base = int(ckpt.get("base", 32))
    if base < 1 or base > 64:
        raise SystemExit(f"export: base {base} out of range [1, 64]")
    norm = ckpt["norm"]
    for key in ("sdfMean", "sdfStd", "alphaScale", "uMean", "uStd", "vMean", "vStd", "cpMean", "cpStd"):
        value = float(norm[key])
        if not np.isfinite(value):
            raise SystemExit(f"export: norm.{key} is not finite")
    model = UNet(base=base)
    model.load_state_dict(ckpt["model"])
    model.eval()

    expected = param_count(base)
    flat = model.flat_params()
    if flat.numel() != expected:
        raise SystemExit(f"export: param count {flat.numel()} != expected {expected}")
    print(f"export: base={base} params={flat.numel()}")

    dummy = torch.zeros(1, IN_CH, NY, NX)
    onnx_path = out_dir / "model.onnx"
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes=None,
        opset_version=18,
    )

    # Python parity check: torch vs onnxruntime on a seeded input.
    import onnxruntime as ort

    torch.manual_seed(7)
    probe = torch.randn(1, IN_CH, NY, NX)
    with torch.no_grad():
        ref = model(probe).numpy()
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    got = sess.run(["output"], {"input": probe.numpy()})[0]
    max_err = float(np.max(np.abs(ref - got)))
    print(f"export: parity max_err={max_err:.3e}")
    if not np.isfinite(max_err) or max_err > 1e-4:
        raise SystemExit(f"export: parity check failed (max_err={max_err})")

    weights = flat.numpy().astype(np.float32)
    weights_path = out_dir / "weights.bin"
    weights_path.write_bytes(weights.tobytes())
    sha = hashlib.sha256(weights.tobytes()).hexdigest()
    manifest = {
        "version": "1",
        "nx": NX,
        "ny": NY,
        "inCh": IN_CH,
        "outCh": OUT_CH,
        "base": base,
        "norm": norm,
        "weightsFile": "weights.bin",
        "weightsSha256": sha,
        "paramCount": int(weights.size),
    }
    (out_dir / "model.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"export: wrote {weights_path} sha256={sha[:12]}...")
    print("export: done")


def export_v2(
    checkpoint: Path,
    norm_sidecar: Path,
    out_dir: Path = V2_OUT_DIR,
    run_id: str | None = None,
) -> dict:
    """Export a unet-v2 checkpoint to public/surrogate/v2/ layout.

    Refuses v1 checkpoints with a clear error, asserts norm sidecar hash
    agreement, and returns the manifest dict for tests and goldens.
    """
    from dataset_v2 import load_norm_sidecar, norm_hash

    if not checkpoint.exists():
        raise SystemExit(f"export: v2 checkpoint missing: {checkpoint} (train first)")
    if not norm_sidecar.exists():
        raise SystemExit(f"export: v2 norm sidecar missing: {norm_sidecar}")
    ckpt = load_checkpoint(checkpoint)
    arch = ckpt.get("arch", None)
    if arch != V2_ARCH:
        raise SystemExit(
            f"export: refusing checkpoint with arch {arch!r} on the v2 path "
            f"(need {V2_ARCH!r}; v1 checkpoints are rejected, never adapted)"
        )
    base = int(ckpt.get("base", -1))
    if base != V2_BASE:
        raise SystemExit(f"export: v2 base is locked to {V2_BASE}, got {base}")
    if int(ckpt.get("inCh", -1)) != V2_IN_CH or int(ckpt.get("outCh", -1)) != V2_OUT_CH:
        raise SystemExit(
            f"export: v2 channels must be {V2_IN_CH}->{V2_OUT_CH}, "
            f"got {ckpt.get('inCh')!r}->{ckpt.get('outCh')!r}"
        )
    sidecar = load_norm_sidecar(norm_sidecar)
    ckpt_norm_hash = norm_hash(ckpt["norm"])
    sidecar_hash = norm_hash(sidecar)
    if ckpt_norm_hash != sidecar_hash:
        raise SystemExit(
            f"export: norm sidecar hash mismatch: checkpoint {ckpt_norm_hash[:12]}... "
            f"!= sidecar {sidecar_hash[:12]}... (sidecar is authoritative)"
        )

    model = UNetV2(base=V2_BASE)
    model.load_state_dict(ckpt["model"])
    model.eval()
    expected = param_count_v2(V2_BASE)
    actual = sum(p.numel() for p in model.parameters())
    if actual != expected:
        raise SystemExit(f"export: v2 param count {actual} != expected {expected}")
    print(f"export: v2 arch={V2_ARCH} base={V2_BASE} params={actual}")

    dummy = torch.zeros(1, V2_IN_CH, NY, NX)
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "model.onnx"
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes=None,
        opset_version=V2_OPSET,
        dynamo=False,
    )

    available, reason = ort_instancenorm_available()
    parity: dict
    if available:
        parity = {"tolerance": V2_TOLERANCE, **check_v2_parity(model, onnx_path)}
    else:
        print(f"export: v2 parity skipped: {reason}")
        parity = {"tolerance": V2_TOLERANCE, "status": "skipped", "maxErr": None, "reason": reason}

    norm_bytes = norm_sidecar.read_bytes()
    (out_dir / "norm.json").write_bytes(norm_bytes)
    model_sha = sha256_file(onnx_path)
    norm_sha = hashlib.sha256(norm_bytes).hexdigest()
    resolved_run_id = run_id or str(ckpt.get("runId", ""))
    manifest = {
        "version": "2",
        "arch": V2_ARCH,
        "base": V2_BASE,
        "inCh": V2_IN_CH,
        "outCh": V2_OUT_CH,
        "nx": NX,
        "ny": NY,
        "opset": V2_OPSET,
        "files": {
            "model": {"path": "model.onnx", "sha256": model_sha},
            "norm": {"path": "norm.json", "sha256": norm_sha},
        },
        "normSha256": norm_sha,
        "runId": resolved_run_id,
        "provenance": {
            "checkpoint": str(checkpoint),
            "exporter": "training/export_onnx.py",
            "parity": parity,
            "postActivations": "sigmoid and expm1 stay in the TypeScript consumer, never in ONNX",
        },
    }
    (out_dir / "model.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"export: wrote {onnx_path} sha256={model_sha[:12]}...")
    print(f"export: wrote {out_dir / 'norm.json'} sha256={norm_sha[:12]}...")
    print("export: done")
    return manifest


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Export a trained surrogate to ONNX plus manifest")
    parser.add_argument("--checkpoint", type=Path, default=None, help="checkpoint path (default: v1 best.pt)")
    parser.add_argument("--out-dir", type=Path, default=None, help="output dir (default: public/surrogate)")
    parser.add_argument(
        "--run-id",
        default=None,
        help="v2 run id: reads training/checkpoints/v2/<run_id>/best.pt plus norm.json, writes public/surrogate/v2/",
    )
    parser.add_argument(
        "--norm-sidecar",
        type=Path,
        default=None,
        help="v2 norm.json sidecar path (default: alongside a v2 checkpoint)",
    )
    args = parser.parse_args(argv)

    if args.run_id is not None:
        ckpt_dir = V2_CHECKPOINT_ROOT / args.run_id
        export_v2(
            checkpoint=args.checkpoint or (ckpt_dir / "best.pt"),
            norm_sidecar=args.norm_sidecar or (ckpt_dir / "norm.json"),
            out_dir=args.out_dir or V2_OUT_DIR,
            run_id=args.run_id,
        )
        return

    checkpoint = args.checkpoint or CHECKPOINT
    if not checkpoint.exists():
        raise SystemExit(f"export: checkpoint missing: {checkpoint} (train first)")
    ckpt = load_checkpoint(checkpoint)
    if ckpt.get("arch", None) == V2_ARCH:
        sidecar = args.norm_sidecar or (checkpoint.parent / "norm.json")
        export_v2(
            checkpoint=checkpoint,
            norm_sidecar=sidecar,
            out_dir=args.out_dir or V2_OUT_DIR,
            run_id=str(ckpt.get("runId", "")),
        )
        return
    if args.norm_sidecar is not None:
        raise SystemExit("export: --norm-sidecar is v2 only, but the checkpoint is not unet-v2")
    export_v1(checkpoint=checkpoint, out_dir=args.out_dir or OUT_DIR)


if __name__ == "__main__":
    main()
