"""Compact U-Net for the GearFlow Phase 3 surrogate.

Maps 3 input channels (normalized SDF, solid mask, tiled alpha encoding) to
3 output channels (u, v, Cp) on the fixed 128 by 128 grid.

The layer order is the contract with the TypeScript forward pass in
src/flow/surrogate.ts: convs live in a ModuleList in exact inference order
(conv weights then bias per layer, row-major [out, in, ky, kx] flatten).
No normalization layers: the TS path implements conv plus ReLU only, so
parity stays exact. Kaiming init keeps the unnormalized stack trainable.
"""

import torch
from torch import nn

IN_CH = 3
OUT_CH = 3
BASE = 32
LEVELS = 3

# (name, in_ch, out_ch, kernel) in TS forward order, built from base.
def layer_order(base: int) -> list[tuple[str, int, int, int]]:
    if not isinstance(base, int) or base < 1 or base > 64:
        raise ValueError(f"base must be an integer in [1, 64], got {base}")
    b = base
    return [
        ("enc1_1", 3, b, 3),
        ("enc1_2", b, b, 3),
        ("enc2_1", b, 2 * b, 3),
        ("enc2_2", 2 * b, 2 * b, 3),
        ("enc3_1", 2 * b, 4 * b, 3),
        ("enc3_2", 4 * b, 4 * b, 3),
        ("bot_1", 4 * b, 8 * b, 3),
        ("bot_2", 8 * b, 8 * b, 3),
        ("dec3_1", 12 * b, 4 * b, 3),
        ("dec3_2", 4 * b, 4 * b, 3),
        ("dec2_1", 6 * b, 2 * b, 3),
        ("dec2_2", 2 * b, 2 * b, 3),
        ("dec1_1", 3 * b, b, 3),
        ("dec1_2", b, b, 3),
        ("head", b, OUT_CH, 1),
    ]


# Canonical order at the default width. Kept for import compatibility;
# UNet and param_count always build from the requested base instead.
LAYER_ORDER = layer_order(BASE)


class UNet(nn.Module):
    def __init__(self, in_ch: int = IN_CH, out_ch: int = OUT_CH, base: int = BASE):
        super().__init__()
        if in_ch != IN_CH or out_ch != OUT_CH:
            raise ValueError(f"UNet contract is {IN_CH}->{OUT_CH}, got {in_ch}->{out_ch}")
        if not isinstance(base, int) or base < 1 or base > 64:
            raise ValueError(f"base must be an integer in [1, 64], got {base}")
        self.base = base
        self.in_ch = in_ch
        self.out_ch = out_ch
        self.levels = LEVELS
        self.convs = nn.ModuleList()
        self.names: list[str] = []
        for name, ci, co, k in layer_order(base):
            conv = nn.Conv2d(ci, co, kernel_size=k, padding=k // 2, bias=True)
            nn.init.kaiming_normal_(conv.weight, nonlinearity="relu" if name != "head" else "linear")
            nn.init.zeros_(conv.bias)
            self.convs.append(conv)
            self.names.append(name)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        skips = []
        h = x
        # Encoder: conv, relu, conv, relu, pool per level.
        for level in range(LEVELS):
            h = torch.relu(self.convs[level * 2](h))
            h = torch.relu(self.convs[level * 2 + 1](h))
            skips.append(h)
            h = nn.functional.max_pool2d(h, 2)
        # Bottleneck.
        h = torch.relu(self.convs[6](h))
        h = torch.relu(self.convs[7](h))
        # Decoder: upsample, concat, conv, relu, conv, relu per level.
        for level in range(LEVELS):
            h = nn.functional.interpolate(h, scale_factor=2, mode="nearest")
            skip = skips[LEVELS - 1 - level]
            h = torch.cat([h, skip], dim=1)
            h = torch.relu(self.convs[8 + level * 2](h))
            h = torch.relu(self.convs[8 + level * 2 + 1](h))
        return self.convs[14](h)

    def flat_params(self) -> torch.Tensor:
        """All params in TS forward order: weight flattened then bias, per conv."""
        parts = []
        for conv in self.convs:
            parts.append(conv.weight.detach().reshape(-1))
            parts.append(conv.bias.detach().reshape(-1))
        return torch.cat(parts)


def param_count(base: int = BASE) -> int:
    total = 0
    for _, ci, co, k in layer_order(base):
        total += co * ci * k * k + co
    return total


# UNet v2 (Modal C-1 contract, docs/ARCHITECTURE.md "Modal training and sweep").
#
# Identifier `unet-v2`. v1 above is untouched; v1 checkpoints are rejected by
# the v2 loaders, never adapted.
#
# Inputs (batch, 4, 128, 128): sdf clipped (-3, 3) standardized; mask identity
# 0/1; alpha degrees tiled over alphaScale 12; logRe base 10 standardized.
# Outputs (batch, 6, 128, 128): meanU, meanV, cp, vorticity, tke (log1p), and
# recirc (raw logit). Sigmoid and expm1 stay in the consumer, never here.
#
# Network: encoder 8/16/32, bottleneck 64, symmetric decoder, head 8 to 6 via
# 1x1 conv. Every non head conv is followed by GroupNorm (4 groups, eps 1e-5,
# affine) then ReLU. Nearest upsample and max pool, as v1. Base 8 is locked
# for v2 production: 122934 parameters exactly.

V2_ARCH = "unet-v2"
V2_IN_CH = 4
V2_OUT_CH = 6
V2_BASE = 8
V2_GROUPS = 4
V2_GN_EPS = 1e-5

V2_IN_HEADS = ("sdf", "mask", "alpha", "logRe")
V2_OUT_HEADS = ("meanU", "meanV", "cp", "vorticity", "tke", "recirc")


def v2_layer_order(base: int) -> list[tuple[str, int, int, int]]:
    if not isinstance(base, int) or base != V2_BASE:
        raise ValueError(f"v2 base is locked to {V2_BASE}, got {base}")
    b = base
    return [
        ("enc1_1", V2_IN_CH, b, 3),
        ("enc1_2", b, b, 3),
        ("enc2_1", b, 2 * b, 3),
        ("enc2_2", 2 * b, 2 * b, 3),
        ("enc3_1", 2 * b, 4 * b, 3),
        ("enc3_2", 4 * b, 4 * b, 3),
        ("bot_1", 4 * b, 8 * b, 3),
        ("bot_2", 8 * b, 8 * b, 3),
        ("dec3_1", 12 * b, 4 * b, 3),
        ("dec3_2", 4 * b, 4 * b, 3),
        ("dec2_1", 6 * b, 2 * b, 3),
        ("dec2_2", 2 * b, 2 * b, 3),
        ("dec1_1", 3 * b, b, 3),
        ("dec1_2", b, b, 3),
        ("head", b, V2_OUT_CH, 1),
    ]


class UNetV2(nn.Module):
    """Base 8 U-Net with GroupNorm for the v2 surrogate (4 in, 6 out)."""

    def __init__(self, base: int = V2_BASE):
        super().__init__()
        if not isinstance(base, int) or base != V2_BASE:
            raise ValueError(f"v2 base is locked to {V2_BASE}, got {base}")
        self.arch = V2_ARCH
        self.base = base
        self.in_ch = V2_IN_CH
        self.out_ch = V2_OUT_CH
        self.levels = LEVELS
        self.convs = nn.ModuleList()
        self.norms = nn.ModuleList()
        self.names: list[str] = []
        for name, ci, co, k in v2_layer_order(base):
            conv = nn.Conv2d(ci, co, kernel_size=k, padding=k // 2, bias=True)
            nn.init.kaiming_normal_(conv.weight, nonlinearity="relu" if name != "head" else "linear")
            nn.init.zeros_(conv.bias)
            self.convs.append(conv)
            self.names.append(name)
            if name == "head":
                self.norms.append(nn.Identity())
            else:
                self.norms.append(nn.GroupNorm(num_groups=V2_GROUPS, num_channels=co, eps=V2_GN_EPS, affine=True))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        skips = []
        h = x
        # Encoder: conv, norm, relu, conv, norm, relu, pool per level.
        for level in range(LEVELS):
            h = torch.relu(self.norms[level * 2](self.convs[level * 2](h)))
            h = torch.relu(self.norms[level * 2 + 1](self.convs[level * 2 + 1](h)))
            skips.append(h)
            h = nn.functional.max_pool2d(h, 2)
        # Bottleneck.
        h = torch.relu(self.norms[6](self.convs[6](h)))
        h = torch.relu(self.norms[7](self.convs[7](h)))
        # Decoder: upsample, concat, conv, norm, relu, conv, norm, relu.
        for level in range(LEVELS):
            h = nn.functional.interpolate(h, scale_factor=2, mode="nearest")
            skip = skips[LEVELS - 1 - level]
            h = torch.cat([h, skip], dim=1)
            h = torch.relu(self.norms[8 + level * 2](self.convs[8 + level * 2](h)))
            h = torch.relu(self.norms[8 + level * 2 + 1](self.convs[8 + level * 2 + 1](h)))
        return self.convs[14](h)


def param_count_v2(base: int = V2_BASE) -> int:
    total = 0
    for name, ci, co, k in v2_layer_order(base):
        total += co * ci * k * k + co
        if name != "head":
            total += 2 * co
    return total


def register_v2_onnx_symbolic(opset: int = 18) -> None:
    """Map aten group_norm to the GroupNormalization ONNX op for v2 export.

    Both the TorchScript and dynamo ONNX translators decompose GroupNorm
    into reshape plus InstanceNormalization by default, which the TypeScript
    consumer does not implement. Call this once before torch.onnx.export
    (C-5 export phase) so the graph carries GroupNormalization directly.
    Forward numerics and parameters are unchanged.
    """
    from torch.onnx import register_custom_op_symbolic
    from torch.onnx.symbolic_helper import _get_const

    def group_norm_symbolic(g: object, x: object, groups: object, w: object, b: object, eps: object, _cudnn: bool) -> object:
        n_groups = _get_const(groups, "i", "num_groups")
        epsilon = _get_const(eps, "f", "eps")
        return g.op("GroupNormalization", x, w, b, num_groups_i=n_groups, epsilon_f=epsilon)  # type: ignore[union-attr]

    register_custom_op_symbolic("aten::group_norm", group_norm_symbolic, opset)
