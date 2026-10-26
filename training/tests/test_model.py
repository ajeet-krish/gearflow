"""Model shape contract: in_ch 3, out_ch 3, base 32, fixed grid."""

import torch

from model import IN_CH, OUT_CH, UNet, param_count


def test_forward_shapes() -> None:
    model = UNet()
    model.eval()
    with torch.no_grad():
        out = model(torch.zeros(1, IN_CH, 128, 128))
    assert out.shape == (1, OUT_CH, 128, 128)
    assert torch.isfinite(out).all()


def test_param_count_matches_ts_contract() -> None:
    from model import LAYER_ORDER

    model = UNet(base=32)
    assert model.flat_params().numel() == param_count(32)
    assert len(LAYER_ORDER) == 15


def test_base_arg_builds_matching_layers() -> None:
    """UNet must honor base: cross-check param counts at base 2 and 8."""
    from model import layer_order

    for base in (2, 8):
        model = UNet(base=base)
        assert model.base == base
        assert model.flat_params().numel() == param_count(base)
        assert len(model.convs) == len(layer_order(base)) == 15
        first = model.convs[0]
        assert first.out_channels == base
    small = UNet(base=2).flat_params().numel()
    large = UNet(base=8).flat_params().numel()
    assert small < large
    assert small == param_count(2)
    assert large == param_count(8)


def test_base_arg_rejects_out_of_range() -> None:
    import pytest

    for bad in (0, -1, 65, 128):
        with pytest.raises(ValueError, match="base"):
            UNet(base=bad)
