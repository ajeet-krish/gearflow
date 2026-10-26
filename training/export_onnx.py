"""ONNX export plus browser manifest. Run by the user after training.

Usage: uv run --project training python export_onnx.py
Reads training/checkpoints/best.pt, exports opset 18 with batch 1, runs a
Python parity check (torch vs onnxruntime on a fixed seed input), writes
public/surrogate/model.json (shapes, norm stats, SHA256) and
public/surrogate/weights.bin (Float32 params in TS forward order).
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from model import IN_CH, OUT_CH, UNet, param_count

HERE = Path(__file__).parent
CHECKPOINT = HERE / "checkpoints" / "best.pt"
OUT_DIR = HERE.parent / "public" / "surrogate"
NX = 128
NY = 128


def main() -> None:
    if not CHECKPOINT.exists():
        raise SystemExit(f"export: checkpoint missing: {CHECKPOINT} (train first)")
    ckpt = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
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
    onnx_path = OUT_DIR / "model.onnx"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
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
    weights_path = OUT_DIR / "weights.bin"
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
    (OUT_DIR / "model.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"export: wrote {weights_path} sha256={sha[:12]}...")
    print("export: done")


if __name__ == "__main__":
    main()
