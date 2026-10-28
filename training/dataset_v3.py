"""V3 datasets: LBM v3 adapter plus analytic adapter on the canonical grid.

Canonical grid: 128 by 128 over x in [-0.5, 2.0], y in [-1.0, 1.0], node
rule k = j * nx + i (C order, no row flips). Continuous channels resample
with bilinear (align corners); mask and recirc resample with nearest and a
0.5 threshold. Solid cells are zeroed in every spatial head after resample.

Inputs (4, 128, 128), identical to v2: sdf clipped (-3, 3) standardized;
mask identity 0/1; alpha degrees tiled over alphaScale 12; logRe base 10
standardized. A missing or non positive Re is a hard error.

Spatial heads (10, 128, 128): meanU, meanV, cp, vorticity, tke (log1p),
recirc (raw 0/1), uCos, uSin, vCos, vSin. Mean heads reuse the v2
conversions unchanged. Harmonic heads convert with U_ref = u_lattice:
raw = bin / u_lattice, non finite to 0, bilinear resample with aligned
corners, clip (-3, 3), then zero solid cells. Each cos/sin pair is
resampled in one stacked interpolate so the phase relationship survives.

Aux heads (3,): strouhal (normalized), explained (raw in [0, 1]),
harmonicValid (raw 0/1). Aux mask (3,) is 1 for strouhal only when
harmonic_valid is true, and 1 for explained and validity always. Sample
weight is 1.0 when valid, 0.05 when invalid.

Only completed rows are used. Any completed row with sha_version below 3
raises a clear error; older rows are never padded with zeros. Splits use
split_completed_rows from dataset_v2 with unchanged stratification, and
each instance reports harmonic valid counts for both splits.
"""

import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from dataset_v2 import (
    ALPHA_SCALE,
    CP_CLIP,
    FREESTREAM,
    NX,
    NY,
    SDF_CLIP,
    VORT_CLIP,
    clean_finite,
    is_completed_row,
    log_re_of,
    resample_continuous,
    resample_label,
    sdf_from_mask,
    split_completed_rows,
)
from model import V2_NORM_EPS, V2_NORM_OP

NORM_SCHEMA_V3 = "gearflow-surrogate-norm/v3"

V3_IN_HEADS = ("sdf", "mask", "alpha", "logRe")
V3_OUT_HEADS = ("meanU", "meanV", "cp", "vorticity", "tke", "recirc", "uCos", "uSin", "vCos", "vSin")
V3_AUX_HEADS = ("strouhal", "explained", "harmonicValid")

HARM_CLIP = 3.0
HARM_BINS = ("ucos", "usin", "vcos", "vsin")
HARM_CHANNELS = (6, 7, 8, 9)
VALID_WEIGHT = 1.0
INVALID_WEIGHT = 0.05
PAIR_RMS_FLOOR = 1e-3
SHA_MIN = 3


def _sha_of(row: dict) -> int | None:
    raw = row.get("sha_version", None)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def require_sha_v3(row: dict) -> None:
    """Raise a clear error unless a completed row carries sha_version >= 3."""
    sha = _sha_of(row)
    case_id = str(row.get("case_id", "?"))
    if sha is None or sha < SHA_MIN:
        raise ValueError(
            f"case {case_id} has sha_version {row.get('sha_version')!r}, "
            f"v3 requires sha_version >= {SHA_MIN} "
            "(older rows carry no harmonic bins and must not be zero filled)"
        )


def harmonic_valid_of(row: dict) -> bool:
    raw = row.get("harmonic_valid", False)
    if isinstance(raw, str):
        return raw.strip().lower() in ("1", "true", "yes")
    return bool(raw)


def _strouhal_raw_of(row: dict) -> float:
    raw = row.get("strouhal", None)
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(value):
        return 0.0
    return value


def _explained_raw_of(row: dict) -> float:
    raw = row.get("explained_variance", row.get("explained", 0.0))
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(value):
        return 0.0
    return float(min(max(value, 0.0), 1.0))


def resample_pair(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear resample of a channel pair in one op, align corners.

    Stacking both channels into a single interpolate keeps the sampling
    grid bit identical for cos and sin so a phase relationship survives.
    """
    if a.shape == (NY, NX) and b.shape == (NY, NX):
        return a.astype(np.float32, copy=True), b.astype(np.float32, copy=True)
    stacked = np.stack(
        [np.ascontiguousarray(a, dtype=np.float32), np.ascontiguousarray(b, dtype=np.float32)]
    )
    t = torch.from_numpy(stacked).unsqueeze(0)
    out = torch.nn.functional.interpolate(t, size=(NY, NX), mode="bilinear", align_corners=True)
    pair = out.squeeze(0).numpy().astype(np.float32)
    return pair[0], pair[1]


def harmonic_from_bin(bin_field: np.ndarray, u_ref: float) -> np.ndarray:
    """Scale a raw harmonic bin to lattice units, cleaning non finite to 0."""
    with np.errstate(divide="ignore", invalid="ignore"):
        scaled = bin_field.astype(np.float32) / np.float32(u_ref)
    return clean_finite(scaled, 0.0)


def convert_harmonic_pair(
    cos_raw: np.ndarray,
    sin_raw: np.ndarray,
    u_ref: float,
    fluid: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert one cos/sin pair: scale, joint resample, clip, zero solid."""
    cos_scaled = harmonic_from_bin(cos_raw, u_ref)
    sin_scaled = harmonic_from_bin(sin_raw, u_ref)
    cos_rs, sin_rs = resample_pair(cos_scaled, sin_scaled)
    cos_rs = np.clip(cos_rs, -HARM_CLIP, HARM_CLIP) * fluid
    sin_rs = np.clip(sin_rs, -HARM_CLIP, HARM_CLIP) * fluid
    return cos_rs.astype(np.float32), sin_rs.astype(np.float32)


def empty_norm_v3() -> dict:
    norm: dict = {
        "schema": NORM_SCHEMA_V3,
        "alphaScale": ALPHA_SCALE,
        "normalization": {"operator": V2_NORM_OP, "groups": None, "eps": V2_NORM_EPS},
        "inputs": {
            "sdf": {"mean": 0.0, "std": 1.0},
            "logRe": {"mean": 0.0, "std": 1.0},
        },
        "outputs": {},
        "aux": {"strouhal": {"mean": 0.0, "std": 1.0}},
        "clips": {
            "sdf": [-SDF_CLIP, SDF_CLIP],
            "cp": [-CP_CLIP, CP_CLIP],
            "vorticity": [-VORT_CLIP, VORT_CLIP],
            "harmonic": [-HARM_CLIP, HARM_CLIP],
        },
        "nFit": 0,
        "fittedOn": "",
    }
    for name in V3_OUT_HEADS:
        if name == "recirc":
            continue
        entry: dict = {"mean": 0.0, "std": 1.0}
        if name in ("tke", "uCos", "uSin", "vCos", "vSin"):
            entry["degenerate"] = False
        norm["outputs"][name] = entry
    return norm


def _fluid_of_raw_input(raw_x: np.ndarray) -> np.ndarray:
    return (raw_x[1] < 0.5).astype(np.float64)


def _pooled_pair_std(values_a: list[np.ndarray], values_b: list[np.ndarray], fluids: list[np.ndarray]) -> tuple[float, bool]:
    num = 0.0
    den = 0
    for a, b, fluid in zip(values_a, values_b, fluids):
        a64 = a.astype(np.float64)
        b64 = b.astype(np.float64)
        f = fluid.astype(np.float64)
        num += float(((a64 * a64) + (b64 * b64))[f > 0.5].sum())
        den += int((f > 0.5).sum())
    if den <= 0:
        return 1.0, True
    rms = float(np.sqrt(num / (2.0 * den)))
    if rms < PAIR_RMS_FLOOR:
        return 1.0, True
    return rms, False


def fit_norm_v3(
    raw_inputs: list[np.ndarray],
    raw_spatial: list[np.ndarray],
    strouhal_vals: list[float],
    fitted_on: str = "",
) -> dict:
    """Fit a v3 norm on train raw samples only.

    Extends the v2 fit: input sdf/logRe stats plus meanU, meanV, cp,
    vorticity, tke stats reuse v2 math (tke degenerate guard included).
    Harmonic means are forced to exactly 0.0 with one pooled RMS std per
    velocity pair written identically to both entries; an RMS below 0.001
    pins std to 1.0 and records degenerate true. Strouhal mean/std fit over
    the valid sample values only; with no valid samples they stay 0/1.
    """
    if not raw_inputs or len(raw_inputs) != len(raw_spatial):
        raise ValueError("fit_norm_v3 needs matching non empty raw input/spatial lists")
    norm = empty_norm_v3()
    xs = np.stack([np.asarray(x, dtype=np.float64) for x in raw_inputs])
    ys = np.stack([np.asarray(y, dtype=np.float64) for y in raw_spatial])
    if xs.shape[1] != 4 or ys.shape[1] != 10:
        raise ValueError(f"v3 fit needs (4, H, W) inputs and (10, H, W) targets, got {xs.shape} and {ys.shape}")
    for key, idx in (("sdf", 0), ("logRe", 3)):
        mu = float(xs[:, idx].mean())
        sd = float(xs[:, idx].std())
        norm["inputs"][key] = {"mean": mu, "std": max(sd, 1e-6)}
    for i, name in enumerate(("meanU", "meanV", "cp", "vorticity", "tke")):
        mu = float(ys[:, i].mean())
        sd = float(ys[:, i].std())
        if name == "tke" and sd < 1e-3:
            norm["outputs"][name] = {"mean": 0.0, "std": 1.0, "degenerate": True}
        else:
            entry = {"mean": mu, "std": max(sd, 1e-6)}
            if name == "tke":
                entry["degenerate"] = False
            norm["outputs"][name] = entry
    fluids = [_fluid_of_raw_input(x) for x in raw_inputs]
    u_cos = [np.asarray(y[6], dtype=np.float32) for y in raw_spatial]
    u_sin = [np.asarray(y[7], dtype=np.float32) for y in raw_spatial]
    v_cos = [np.asarray(y[8], dtype=np.float32) for y in raw_spatial]
    v_sin = [np.asarray(y[9], dtype=np.float32) for y in raw_spatial]
    std_u, deg_u = _pooled_pair_std(u_cos, u_sin, fluids)
    std_v, deg_v = _pooled_pair_std(v_cos, v_sin, fluids)
    norm["outputs"]["uCos"] = {"mean": 0.0, "std": std_u, "degenerate": deg_u}
    norm["outputs"]["uSin"] = {"mean": 0.0, "std": std_u, "degenerate": deg_u}
    norm["outputs"]["vCos"] = {"mean": 0.0, "std": std_v, "degenerate": deg_v}
    norm["outputs"]["vSin"] = {"mean": 0.0, "std": std_v, "degenerate": deg_v}
    vals = [float(v) for v in strouhal_vals if np.isfinite(float(v))]
    if vals:
        arr = np.asarray(vals, dtype=np.float64)
        norm["aux"]["strouhal"] = {"mean": float(arr.mean()), "std": max(float(arr.std()), 1e-6)}
    else:
        norm["aux"]["strouhal"] = {"mean": 0.0, "std": 1.0}
    norm["nFit"] = len(raw_inputs)
    norm["fittedOn"] = fitted_on
    return norm


def with_refit_outputs_v3(
    frozen: dict,
    raw_inputs: list[np.ndarray],
    raw_spatial: list[np.ndarray],
    strouhal_vals: list[float],
    fitted_on: str = "",
) -> dict:
    """Refit output and aux stats on LBM train samples, inputs frozen."""
    refit = fit_norm_v3(raw_inputs, raw_spatial, strouhal_vals, fitted_on)
    out = copy.deepcopy(frozen)
    out["outputs"] = refit["outputs"]
    out["aux"] = refit["aux"]
    out["nFit"] = len(raw_spatial)
    out["fittedOn"] = fitted_on
    return out


def normalize_sample_v3(
    raw_x: np.ndarray, raw_y: np.ndarray, raw_aux: np.ndarray, norm: dict
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Map raw physical v3 sample to normalized model space."""
    sdf = np.clip(raw_x[0], -SDF_CLIP, SDF_CLIP)
    sdf_n = (sdf - norm["inputs"]["sdf"]["mean"]) / norm["inputs"]["sdf"]["std"]
    mask = raw_x[1]
    alpha_n = np.full_like(sdf, float(raw_x[2].mean()) / float(norm["alphaScale"]))
    logre_n = np.full_like(sdf, (float(raw_x[3].mean()) - norm["inputs"]["logRe"]["mean"]) / norm["inputs"]["logRe"]["std"])
    x = np.stack([sdf_n, mask, alpha_n, logre_n]).astype(np.float32)
    heads: list[np.ndarray] = []
    for i, name in enumerate(V3_OUT_HEADS):
        if name == "recirc":
            heads.append(raw_y[i].astype(np.float32))
        else:
            st = norm["outputs"][name]
            heads.append(((raw_y[i] - st["mean"]) / st["std"]).astype(np.float32))
    y = np.stack(heads).astype(np.float32)
    st_aux = norm["aux"]["strouhal"]
    strouhal_n = (float(raw_aux[0]) - st_aux["mean"]) / st_aux["std"]
    aux = np.asarray([strouhal_n, float(raw_aux[1]), float(raw_aux[2])], dtype=np.float32)
    if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y)) and np.all(np.isfinite(aux))):
        raise ValueError("normalized v3 sample has non-finite values")
    return x, y, aux


def canonical_norm_json_v3(norm: dict) -> str:
    return json.dumps(norm, sort_keys=True, separators=(",", ":")) + "\n"


def norm_hash_v3(norm: dict) -> str:
    return hashlib.sha256(canonical_norm_json_v3(norm).encode()).hexdigest()


def _require_v3_normalization(norm: dict) -> None:
    desc = norm.get("normalization", None)
    if (
        not isinstance(desc, dict)
        or desc.get("operator") != V2_NORM_OP
        or desc.get("groups", "missing") is not None
        or desc.get("eps") != V2_NORM_EPS
    ):
        raise ValueError(f"norm normalization must stay InstanceNorm pinned, got {desc!r}")


def _read_manifest_rows(manifest_path: Path) -> list[dict]:
    rows = []
    with open(manifest_path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _lbm_input_channels(
    row: dict, obstacle: np.ndarray, sdf: np.ndarray, log_re: float
) -> np.ndarray:
    alpha = np.full((NY, NX), float(row.get("alpha_deg", 0.0)), dtype=np.float32)
    logre = np.full((NY, NX), log_re, dtype=np.float32)
    return np.stack([sdf, obstacle, alpha, logre]).astype(np.float32)


class AnalyticV3Dataset(Dataset):
    """Analytic shards adapted to the v3 4-in/10-out plus 3-aux contract."""

    def __init__(self, data_dir: Path, split: str, norm: dict | None = None):
        if split not in ("train", "val"):
            raise ValueError(f"split must be train or val, got {split}")
        from dataset import _require_geometry_fields, is_reserved_combo

        self.split = split
        self.data_dir = Path(data_dir)
        rows = _read_manifest_rows(self.data_dir.parent / "manifest.jsonl")
        for e in rows:
            _require_geometry_fields(e, str(e.get("id", "?")))
        wanted = [e for e in rows if e["split"] == split]
        if not wanted:
            raise ValueError(f"no manifest entries for split {split}")
        if split == "train":
            reserved = [e["id"] for e in wanted if is_reserved_combo(e)]
            if reserved:
                raise ValueError(f"leakage: {len(reserved)} reserved anchors in train")
        self._entries = wanted
        self.ids = [e["id"] for e in wanted]
        self.sdf_source = {e["id"]: "analytic" for e in wanted}
        if norm is None:
            raw_x, raw_y, raw_st = self._load_all_raw()
            self.norm = fit_norm_v3(raw_x, raw_y, raw_st, fitted_on=f"analytic-v3:{split}")
        else:
            self.norm = norm

    def _load_shard_sample(self, entry: dict) -> np.ndarray:
        shard = self.data_dir / f"shard-{entry['shard']:03d}.npy"
        if shard.with_suffix(".npz").exists():
            shard = shard.with_suffix(".npz")
        with np.load(shard) as z:
            key = entry["id"]
            if key not in z.files:
                key = f"{entry['id']}.npy"
            if key not in z.files:
                raise ValueError(f"sample {entry['id']} missing in {shard}")
            s = z[key]
        if s.shape != (6, NY, NX):
            raise ValueError(f"sample {entry['id']} shape {s.shape} != (6, {NY}, {NX})")
        if s.dtype != np.float32:
            raise ValueError(f"sample {entry['id']} dtype {s.dtype} != float32")
        if not np.all(np.isfinite(s)):
            raise ValueError(f"sample {entry['id']} has non-finite values")
        return s

    def _raw_sample(self, entry: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
        s = self._load_shard_sample(entry)
        log_re = log_re_of(entry)
        sdf = np.clip(clean_finite(s[0], 3.0), -SDF_CLIP, SDF_CLIP)
        mask = (s[1] > 0.5).astype(np.float32)
        fluid = 1.0 - mask
        alpha = np.full_like(sdf, float(s[2].mean()))
        logre = np.full_like(sdf, log_re)
        x = np.stack([sdf, mask, alpha, logre]).astype(np.float32)
        u = clean_finite(s[3], FREESTREAM["meanU"])
        v = clean_finite(s[4], FREESTREAM["meanV"])
        cp = np.clip(clean_finite(s[5], FREESTREAM["cp"]), -CP_CLIP, CP_CLIP)
        from dataset_v2 import vorticity_from_uv

        vort = np.clip(vorticity_from_uv(u, v), -VORT_CLIP, VORT_CLIP)
        tke = np.full_like(sdf, float(np.log1p(0.0)))
        recirc = ((u < 0.0) * fluid).astype(np.float32)
        zero = np.zeros_like(sdf, dtype=np.float32)
        y = np.stack([u, v, cp, vort, tke, zero, zero, zero, zero, recirc]).astype(np.float32)
        y = (y * fluid).astype(np.float32)
        aux = np.asarray([0.0, 0.0, 0.0], dtype=np.float32)
        aux_mask = np.asarray([0.0, 1.0, 1.0], dtype=np.float32)
        return x, y, aux, aux_mask, float(INVALID_WEIGHT)

    def _load_all_raw(self) -> tuple[list[np.ndarray], list[np.ndarray], list[float]]:
        xs, ys = [], []
        for e in self._entries:
            x, y, _, _, _ = self._raw_sample(e)
            xs.append(x)
            ys.append(y)
        return xs, ys, []

    def __len__(self) -> int:
        return len(self._entries)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        entry = self._entries[idx]
        raw_x, raw_y, raw_aux, aux_mask, weight = self._raw_sample(entry)
        x, y, aux = normalize_sample_v3(raw_x, raw_y, raw_aux, self.norm)
        fluid = (raw_x[1] < 0.5).astype(np.float32)[None]
        return (
            torch.from_numpy(x),
            torch.from_numpy(y),
            torch.from_numpy(fluid),
            torch.from_numpy(aux),
            torch.from_numpy(aux_mask.astype(np.float32)),
            torch.tensor(float(weight), dtype=torch.float32),
        )


class LbmV3Dataset(Dataset):
    """LBM v3 sweep cases adapted to the 4-in/10-out plus 3-aux contract.

    Layout mirrors LbmV2Dataset with four extra bins per case:
    ucos.f32, usin.f32, vcos.f32, vsin.f32 (harmonic bins in lattice
    velocity units, solid cells exactly zero). Manifest rows carry
    sha_version, harmonic_valid, strouhal (or null), explained_variance.
    """

    def __init__(
        self,
        sweep_dir: Path,
        split: str,
        norm: dict | None = None,
        train_frac: float = 0.8,
    ):
        if split not in ("train", "val"):
            raise ValueError(f"split must be train or val, got {split}")
        self.split = split
        self.sweep_dir = Path(sweep_dir)
        rows = _read_manifest_rows(self.sweep_dir / "manifest.jsonl")
        completed = [r for r in rows if is_completed_row(r)]
        if not completed:
            raise ValueError(f"sweep {self.sweep_dir} has no completed rows, cannot split")
        for r in completed:
            require_sha_v3(r)
        by_case = {str(r["case_id"]): r for r in completed}
        train_ids, val_ids = split_completed_rows(list(by_case.values()), train_frac)
        wanted_ids = train_ids if split == "train" else val_ids
        self._rows = [by_case[c] for c in wanted_ids]
        self.ids = wanted_ids
        self.harmonic_counts = {
            "train": sum(1 for c in train_ids if harmonic_valid_of(by_case[c])),
            "val": sum(1 for c in val_ids if harmonic_valid_of(by_case[c])),
        }
        self.harmonic_train_count = int(self.harmonic_counts["train"])
        self.harmonic_val_count = int(self.harmonic_counts["val"])
        self.n_harmonic_valid = int(self.harmonic_counts[split])
        self.sdf_source: dict[str, str] = {}
        for r in self._rows:
            sdf_bin = self.sweep_dir / "cases" / r["case_id"] / "sdf.f32"
            self.sdf_source[r["case_id"]] = "lbm" if sdf_bin.exists() else "derived_mask"
        if norm is None:
            raw_x, raw_y, raw_st = self._load_all_raw()
            self.norm = fit_norm_v3(raw_x, raw_y, raw_st, fitted_on=f"lbm-v3:{self.sweep_dir.name}:{split}")
        else:
            self.norm = norm

    def _read_bin(self, case_id: str, name: str, nx: int, ny: int) -> np.ndarray:
        path = self.sweep_dir / "cases" / case_id / f"{name}.f32"
        raw = np.fromfile(path, dtype=np.float32)
        if raw.size != nx * ny:
            raise ValueError(f"bin {path} size {raw.size} != {nx}*{ny}")
        if not np.all(np.isfinite(raw)):
            raise ValueError(f"bin {path} has non-finite values")
        return raw.reshape(ny, nx)

    def _raw_sample(self, row: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
        require_sha_v3(row)
        case_id = row["case_id"]
        nx, ny = int(row["nx"]), int(row["ny"])
        u_ref = float(row["u_lattice"])
        ref_len = float(row["ref_length"])
        if not np.isfinite(u_ref) or u_ref <= 0.0:
            raise ValueError(f"case {case_id} has bad u_lattice {row.get('u_lattice')!r}")
        if not np.isfinite(ref_len) or ref_len <= 0.0:
            raise ValueError(f"case {case_id} has bad ref_length {row.get('ref_length')!r}")
        log_re = log_re_of({"id": case_id, "Re": row.get("re", row.get("Re", None))})
        bins: dict[str, np.ndarray] = {}
        for name in ("umean", "vmean", "pmean", "omegamean", "tke", "recirc", "obstacle", "sdf",
                     "ucos", "usin", "vcos", "vsin"):
            path = self.sweep_dir / "cases" / case_id / f"{name}.f32"
            if name == "sdf" and not path.exists():
                continue
            bins[name] = self._read_bin(case_id, name, nx, ny)
        obstacle = resample_label(bins["obstacle"])
        fluid = 1.0 - obstacle
        if "sdf" in bins:
            sdf = np.clip(clean_finite(resample_continuous(bins["sdf"]), 3.0), -SDF_CLIP, SDF_CLIP)
        else:
            sdf = np.clip(sdf_from_mask(obstacle), -SDF_CLIP, SDF_CLIP)
        x = _lbm_input_channels(row, obstacle, sdf, log_re)
        um = clean_finite(resample_continuous(bins["umean"]), FREESTREAM["meanU"]) / u_ref
        vm = clean_finite(resample_continuous(bins["vmean"]), FREESTREAM["meanV"]) / u_ref
        cp = np.clip(
            clean_finite(resample_continuous(bins["pmean"]), 0.0) / (0.5 * u_ref * u_ref),
            -CP_CLIP,
            CP_CLIP,
        )
        vort = np.clip(
            clean_finite(resample_continuous(bins["omegamean"]), 0.0) * ref_len / u_ref,
            -VORT_CLIP,
            VORT_CLIP,
        )
        tke = np.log1p(np.clip(clean_finite(resample_continuous(bins["tke"]), 0.0) / (u_ref * u_ref), 0.0, None))
        recirc = (resample_label(bins["recirc"]) * fluid).astype(np.float32)
        u_cos, u_sin = convert_harmonic_pair(bins["ucos"], bins["usin"], u_ref, fluid)
        v_cos, v_sin = convert_harmonic_pair(bins["vcos"], bins["vsin"], u_ref, fluid)
        y = np.stack([um, vm, cp, vort, tke.astype(np.float32), recirc, u_cos, u_sin, v_cos, v_sin]).astype(np.float32)
        y = (y * fluid).astype(np.float32)
        valid = harmonic_valid_of(row)
        aux = np.asarray([_strouhal_raw_of(row), _explained_raw_of(row), 1.0 if valid else 0.0], dtype=np.float32)
        aux_mask = np.asarray([1.0 if valid else 0.0, 1.0, 1.0], dtype=np.float32)
        weight = float(VALID_WEIGHT if valid else INVALID_WEIGHT)
        return x, y, aux, aux_mask, weight

    def _load_all_raw(self) -> tuple[list[np.ndarray], list[np.ndarray], list[float]]:
        xs, ys, st = [], [], []
        for r in self._rows:
            x, y, aux, mask, _ = self._raw_sample(r)
            xs.append(x)
            ys.append(y)
            if float(mask[0]) > 0.5:
                st.append(float(aux[0]))
        return xs, ys, st

    def __len__(self) -> int:
        return len(self._rows)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        row = self._rows[idx]
        raw_x, raw_y, raw_aux, aux_mask, weight = self._raw_sample(row)
        x, y, aux = normalize_sample_v3(raw_x, raw_y, raw_aux, self.norm)
        fluid = (raw_x[1] < 0.5).astype(np.float32)[None]
        return (
            torch.from_numpy(x),
            torch.from_numpy(y),
            torch.from_numpy(fluid),
            torch.from_numpy(aux),
            torch.from_numpy(aux_mask.astype(np.float32)),
            torch.tensor(float(weight), dtype=torch.float32),
        )
