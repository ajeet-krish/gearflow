"""Export parity: torch forward equals the flattened TS-order weights path."""

import numpy as np
import torch

from model import UNet


def test_flat_params_roundtrip() -> None: 
    torch.manual_seed(7)
    model = UNet()
    model.eval()
    flat = model.flat_params()
    assert flat.numel() > 0
    assert torch.isfinite(flat).all()
    # Rebuild a fresh model from the flat vector and compare one conv.
    other = UNet()
    with torch.no_grad():
        off = 0
        for conv in other.convs:
            w = conv.weight.numel()
            b = conv.bias.numel()
            conv.weight.copy_(flat[off : off + w].reshape(conv.weight.shape))
            off += w
            conv.bias.copy_(flat[off : off + b].reshape(conv.bias.shape))
            off += b
        assert off == flat.numel()
        probe = torch.randn(1, 3, 32, 32)
        a = model(probe)
        c = other(probe)
    assert float((a - c).abs().max()) == 0.0


def test_checkpoint_safe_loads_with_weights_only(tmp_path) -> None:
    """Checkpoints must load with weights_only=True (no pickle code exec)."""
    import torch as _torch

    model = UNet(base=8)
    ckpt = {"model": model.state_dict(), "norm": {"sdfMean": 0.0}, "base": 8, "epoch": 0}
    path = tmp_path / "mini.pt"
    _torch.save(ckpt, path)
    loaded = _torch.load(path, map_location="cpu", weights_only=True)
    assert int(loaded["base"]) == 8
    restored = UNet(base=int(loaded["base"]))
    restored.load_state_dict(loaded["model"])
    restored.eval()
    with _torch.no_grad():
        out = restored(_torch.zeros(1, 3, 32, 32))
    assert out.shape == (1, 3, 32, 32)
    assert bool(_torch.isfinite(out).all())
