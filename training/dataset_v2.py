"""V2 datasets: analytic adapter plus LBM case adapter on the canonical grid.

Canonical grid: 128 by 128 over x in [-0.5, 2.0], y in [-1.0, 1.0], node
rule k = j * nx + i (C order, no row flips). Continuous channels resample
with bilinear (align corners); mask and recirc resample with nearest and a
0.5 threshold. Non finite source values fall back to freestream. Solid cells
are zeroed in every output head after resampling.

Input channels (4, 128, 128): sdf clipped (-3, 3) standardized; mask
identity 0/1; alpha degrees tiled over alphaScale 12; logRe base 10
standardized. A missing or non positive Re is a hard error.

Output channels (6, 128, 128): meanU, meanV, cp, vorticity, tke (log1p),
recirc (raw 0/1). LBM sources convert with U_ref = u_lattice and the case
ref_length: meanU = umean / u_lattice, meanV = vmean / u_lattice,
cp = pmean / (0.5 * u_lattice^2) clipped (-10, 10),
vorticity = omegamean * ref_length / u_lattice clipped (-20, 20),
tke = log1p(tke / u_lattice^2), recirc = bin threshold 0.5.

Normalization is fitted on the train split only. TKE is degenerate when its
fitted std falls below 1e-3 (analytic targets are exactly 0): std is pinned
to 1.0 and the sidecar records degenerate true. Fine tuning freezes the
input section byte for byte and refits only the outputs (see
with_refit_outputs).
"""

import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from model import V2_NORM_EPS, V2_NORM_OP

NX = 128
NY = 128
X_MIN, X_MAX = -0.5, 2.0
Y_MIN, Y_MAX = -1.0, 1.0
ALPHA_SCALE = 12.0
SDF_CLIP = 3.0
CP_CLIP = 10.0
VORT_CLIP = 20.0
TKE_STD_FLOOR = 1e-3
NORM_SCHEMA = "gearflow-surrogate-norm/v2"

V2_IN_HEADS = ("sdf", "mask", "alpha", "logRe")
V2_OUT_HEADS = ("meanU", "meanV", "cp", "vorticity", "tke", "recirc")

DX = (X_MAX - X_MIN) / (NX - 1)
DY = (Y_MAX - Y_MIN) / (NY - 1)

FREESTREAM = {"meanU": 1.0, "meanV": 0.0, "cp": 0.0, "vorticity": 0.0, "tke": 0.0, "recirc": 0.0}

LBM_BIN_ORDER = ("umean", "vmean", "pmean", "omegamean", "tke", "recirc", "obstacle", "sdf")


def log_re_of(entry: dict) -> float:
    """Base 10 log of the entry Reynolds number, or raise."""
    raw = entry.get("Re", entry.get("re", None))
    try:
        re = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"entry {entry.get('id', '?')} missing Reynolds number")
    if not np.isfinite(re) or re <= 0.0:
        raise ValueError(f"entry {entry.get('id', '?')} has non positive Re {raw!r}")
    return float(np.log10(re))


def resample_continuous(field: np.ndarray) -> np.ndarray:
    """Bilinear resample of a (H, W) field to (128, 128), align corners."""
    if field.shape == (NY, NX):
        return field.astype(np.float32, copy=True)
    t = torch.from_numpy(np.ascontiguousarray(field, dtype=np.float32)).unsqueeze(0).unsqueeze(0)
    out = torch.nn.functional.interpolate(t, size=(NY, NX), mode="bilinear", align_corners=True)
    return out.squeeze(0).squeeze(0).numpy().astype(np.float32)


def resample_label(field: np.ndarray) -> np.ndarray:
    """Nearest resample of a (H, W) mask field to (128, 128), threshold 0.5."""
    if field.shape == (NY, NX):
        return (field > 0.5).astype(np.float32)
    t = torch.from_numpy(np.ascontiguousarray(field, dtype=np.float32)).unsqueeze(0).unsqueeze(0)
    out = torch.nn.functional.interpolate(t, size=(NY, NX), mode="nearest")
    return (out.squeeze(0).squeeze(0).numpy() > 0.5).astype(np.float32)


def clean_finite(field: np.ndarray, fill: float) -> np.ndarray:
    """Replace non finite values with the freestream fill (outside domain)."""
    out = field.astype(np.float32, copy=True)
    bad = ~np.isfinite(out)
    if bad.any():
        out[bad] = fill
    return out


def vorticity_from_uv(u: np.ndarray, v: np.ndarray, dx: float = DX, dy: float = DY) -> np.ndarray:
    """Dimensionless curl dv/dx - du/dy via second order central differences."""
    dvdx = np.empty_like(u, dtype=np.float32)
    dudy = np.empty_like(u, dtype=np.float32)
    dvdx[:, 1:-1] = (v[:, 2:] - v[:, :-2]) / (2.0 * dx)
    dvdx[:, 0] = (v[:, 1] - v[:, 0]) / dx
    dvdx[:, -1] = (v[:, -1] - v[:, -2]) / dx
    dudy[1:-1, :] = (u[2:, :] - u[:-2, :]) / (2.0 * dy)
    dudy[0, :] = (u[1, :] - u[0, :]) / dy
    dudy[-1, :] = (u[-1, :] - u[-2, :]) / dy
    return (dvdx - dudy).astype(np.float32)


def sdf_from_mask(mask: np.ndarray, dx: float = DX) -> np.ndarray:
    """Approximate signed distance (cells) from a binary mask, chamfer 3-4.

    Used only for pilot cases without an sdf bin; those samples are marked
    sdf_source derived_mask. Negative inside solid, positive in fluid.
    """
    solid = mask > 0.5
    inside = _chamfer_to_zero(solid) * dx
    outside = _chamfer_to_zero(~solid) * dx
    return (inside - outside).astype(np.float32)


def _chamfer_to_zero(zero: np.ndarray) -> np.ndarray:
    """Distance in cells to the nearest True cell, two pass chamfer."""
    big = float(zero.size + 8)
    d = np.where(zero, 0.0, big).astype(np.float64)
    diag = float(np.sqrt(2.0))
    for i in range(d.shape[0]):
        for j in range(d.shape[1]):
            if d[i, j] == 0.0:
                continue
            best = d[i, j]
            if i > 0:
                best = min(best, d[i - 1, j] + 1.0)
                if j > 0:
                    best = min(best, d[i - 1, j - 1] + diag)
                if j + 1 < d.shape[1]:
                    best = min(best, d[i - 1, j + 1] + diag)
            if j > 0:
                best = min(best, d[i, j - 1] + 1.0)
            d[i, j] = best
    for i in range(d.shape[0] - 1, -1, -1):
        for j in range(d.shape[1] - 1, -1, -1):
            if d[i, j] == 0.0:
                continue
            best = d[i, j]
            if i + 1 < d.shape[0]:
                best = min(best, d[i + 1, j] + 1.0)
                if j > 0:
                    best = min(best, d[i + 1, j - 1] + diag)
                if j + 1 < d.shape[1]:
                    best = min(best, d[i + 1, j + 1] + diag)
            if j + 1 < d.shape[1]:
                best = min(best, d[i, j + 1] + 1.0)
            d[i, j] = best
    return d.astype(np.float32)


def empty_norm() -> dict:
    return {
        "schema": NORM_SCHEMA,
        "alphaScale": ALPHA_SCALE,
        "normalization": {"operator": V2_NORM_OP, "groups": None, "eps": V2_NORM_EPS},
        "inputs": {
            "sdf": {"mean": 0.0, "std": 1.0},
            "logRe": {"mean": 0.0, "std": 1.0},
        },
        "outputs": {
            name: {"mean": 0.0, "std": 1.0, **({"degenerate": False} if name == "tke" else {})}
            for name in V2_OUT_HEADS
            if name != "recirc"
        },
        "clips": {"sdf": [-SDF_CLIP, SDF_CLIP], "cp": [-CP_CLIP, CP_CLIP], "vorticity": [-VORT_CLIP, VORT_CLIP]},
        "nFit": 0,
        "fittedOn": "",
    }


def fit_norm(raw_inputs: list[np.ndarray], raw_targets: list[np.ndarray], fitted_on: str = "") -> dict:
    """Fit a v2 norm on train raw samples only. TKE degenerate guard included."""
    if not raw_inputs or len(raw_inputs) != len(raw_targets):
        raise ValueError("fit_norm needs matching non empty raw input/target lists")
    norm = empty_norm()
    xs = np.stack(raw_inputs).astype(np.float64)
    ys = np.stack(raw_targets).astype(np.float64)
    for key, idx in (("sdf", 0), ("logRe", 3)):
        mu = float(xs[:, idx].mean())
        sd = float(xs[:, idx].std())
        norm["inputs"][key] = {"mean": mu, "std": max(sd, 1e-6)}
    for i, name in enumerate(V2_OUT_HEADS):
        if name == "recirc":
            continue
        mu = float(ys[:, i].mean())
        sd = float(ys[:, i].std())
        if name == "tke" and sd < TKE_STD_FLOOR:
            norm["outputs"][name] = {"mean": 0.0, "std": 1.0, "degenerate": True}
        else:
            entry: dict = {"mean": mu, "std": max(sd, 1e-6)}
            if name == "tke":
                entry["degenerate"] = False
            norm["outputs"][name] = entry
    norm["nFit"] = len(raw_inputs)
    norm["fittedOn"] = fitted_on
    return norm


def with_refit_outputs(frozen: dict, raw_targets: list[np.ndarray], fitted_on: str = "") -> dict:
    """Refit output stats on LBM train targets, keeping inputs byte for byte."""
    refit = fit_norm([np.zeros((4, NY, NX), dtype=np.float32)] * len(raw_targets), raw_targets, fitted_on)
    out = copy.deepcopy(frozen)
    out["outputs"] = refit["outputs"]
    out["nFit"] = len(raw_targets)
    out["fittedOn"] = fitted_on
    return out


def normalize_sample(raw_x: np.ndarray, raw_y: np.ndarray, norm: dict) -> tuple[np.ndarray, np.ndarray]:
    """Map raw physical (4, H, W) and (6, H, W) to normalized model space."""
    sdf = np.clip(raw_x[0], -SDF_CLIP, SDF_CLIP)
    sdf_n = (sdf - norm["inputs"]["sdf"]["mean"]) / norm["inputs"]["sdf"]["std"]
    mask = raw_x[1]
    alpha_n = np.full_like(sdf, float(raw_x[2].mean()) / float(norm["alphaScale"]))
    logre_n = np.full_like(sdf, (float(raw_x[3].mean()) - norm["inputs"]["logRe"]["mean"]) / norm["inputs"]["logRe"]["std"])
    x = np.stack([sdf_n, mask, alpha_n, logre_n]).astype(np.float32)
    heads = []
    for i, name in enumerate(V2_OUT_HEADS):
        if name == "recirc":
            heads.append(raw_y[i].astype(np.float32))
        else:
            st = norm["outputs"][name]
            heads.append(((raw_y[i] - st["mean"]) / st["std"]).astype(np.float32))
    y = np.stack(heads).astype(np.float32)
    if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y))):
        raise ValueError("normalized v2 sample has non-finite values")
    return x, y


def norm_hash(norm: dict) -> str:
    return hashlib.sha256(canonical_norm_json(norm).encode()).hexdigest()


def canonical_norm_json(norm: dict) -> str:
    return json.dumps(norm, sort_keys=True, separators=(",", ":")) + "\n"


def write_norm_sidecar(path: Path, norm: dict) -> str:
    """Write the authoritative norm.json sidecar; return its sha256."""
    if norm.get("schema") != NORM_SCHEMA:
        raise ValueError(f"norm schema must be {NORM_SCHEMA}")
    _require_v2_normalization(norm)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_norm_json(norm))
    return norm_hash(norm)


def load_norm_sidecar(path: Path) -> dict:
    norm = json.loads(Path(path).read_text())
    if norm.get("schema") != NORM_SCHEMA:
        raise ValueError(f"norm schema must be {NORM_SCHEMA}, got {norm.get('schema')!r}")
    _require_v2_normalization(norm)
    return norm


def _require_v2_normalization(norm: dict) -> None:
    """Pin the v2 normalization operator: InstanceNorm, no groups, eps 1e-5."""
    desc = norm.get("normalization", None)
    if (
        not isinstance(desc, dict)
        or desc.get("operator") != V2_NORM_OP
        or desc.get("groups", "missing") is not None
        or desc.get("eps") != V2_NORM_EPS
    ):
        raise ValueError(
            f"norm normalization must be "
            f"{{'operator': {V2_NORM_OP!r}, 'groups': None, 'eps': {V2_NORM_EPS!r}}}, "
            f"got {desc!r} "
            "(GroupNorm sidecars are rejected: onnxruntime-web 1.30.0 cannot run GroupNormalization-18)"
        )


def split_case_ids(case_ids: list[str], train_frac: float = 0.8) -> tuple[list[str], list[str]]:
    """Deterministic 80/20 split over sorted case ids (no stratification)."""
    ordered = sorted(case_ids)
    if len(ordered) < 2:
        raise ValueError("case split needs at least 2 case ids")
    cut = max(1, int(len(ordered) * train_frac))
    if cut >= len(ordered):
        cut = len(ordered) - 1
    return ordered[:cut], ordered[cut:]


def _read_manifest_rows(manifest_path: Path) -> list[dict]:
    rows = []
    with open(manifest_path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


class AnalyticV2Dataset(Dataset):
    """Analytic shards adapted to the v2 4-in/6-out contract (pretrain)."""

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
            raw_x, raw_y = self._load_all_raw()
            self.norm = fit_norm(raw_x, raw_y, fitted_on=f"analytic:{split}")
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

    def _raw_sample(self, entry: dict) -> tuple[np.ndarray, np.ndarray]:
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
        vort = np.clip(vorticity_from_uv(u, v), -VORT_CLIP, VORT_CLIP)
        tke = np.full_like(sdf, float(np.log1p(0.0)))
        recirc = ((u < 0.0) * fluid).astype(np.float32)
        y = np.stack([u, v, cp, vort, tke, recirc]).astype(np.float32)
        y = y * fluid
        return x, y

    def _load_all_raw(self) -> tuple[list[np.ndarray], list[np.ndarray]]:
        xs, ys = [], []
        for e in self._entries:
            x, y = self._raw_sample(e)
            xs.append(x)
            ys.append(y)
        return xs, ys

    def __len__(self) -> int:
        return len(self._entries)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        entry = self._entries[idx]
        raw_x, raw_y = self._raw_sample(entry)
        x, y = normalize_sample(raw_x, raw_y, self.norm)
        fluid = (raw_x[1] < 0.5).astype(np.float32)[None]
        return torch.from_numpy(x), torch.from_numpy(y), torch.from_numpy(fluid)


class LbmV2Dataset(Dataset):
    """LBM sweep cases adapted to the v2 contract (fine tune).

    Layout: <sweep_dir>/manifest.jsonl rows with case_id, nx, ny,
    u_lattice, ref_length, alpha_deg, re; bins under
    <sweep_dir>/cases/<case_id>/{umean,vmean,pmean,omegamean,tke,recirc,
    obstacle,sdf}.f32, each nx*ny float32 in k = j*nx+i order. Cases without
    an sdf bin derive SDF from the obstacle mask and are marked
    sdf_source derived_mask.
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
        by_case = {r["case_id"]: r for r in rows}
        train_ids, val_ids = split_case_ids(list(by_case), train_frac)
        wanted_ids = train_ids if split == "train" else val_ids
        self._rows = [by_case[c] for c in wanted_ids]
        self.ids = wanted_ids
        self.sdf_source: dict[str, str] = {}
        for r in self._rows:
            sdf_bin = self.sweep_dir / "cases" / r["case_id"] / "sdf.f32"
            self.sdf_source[r["case_id"]] = "lbm" if sdf_bin.exists() else "derived_mask"
        if norm is None:
            raw_x, raw_y = self._load_all_raw()
            self.norm = fit_norm(raw_x, raw_y, fitted_on=f"lbm:{self.sweep_dir.name}:{split}")
        else:
            self.norm = norm

    @classmethod
    def staged_for_case(cls, staging_dir: Path, case_dir: Path) -> "LbmV2Dataset":
        """Stage one on-disk pilot case under a sweep layout for _raw_sample.

        Supported single case entry point for tools such as make_golden that
        need the real adapter conversion for exactly one case_id without
        constructing a full sweep dataset. Creates <staging>/cases/<case_id>
        as a symlink to case_dir (copy fallback when symlinks are refused),
        then returns a dataset instance bound to the staging dir with no rows
        loaded. Callers drive _raw_sample with their own row dict. The
        instance carries sweep_dir only; ids and _rows stay empty on purpose.
        """
        import shutil

        staging_dir = Path(staging_dir)
        case_dir = Path(case_dir)
        link = staging_dir / "cases" / case_dir.name
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.exists():
            try:
                link.symlink_to(case_dir, target_is_directory=True)
            except OSError:
                shutil.copytree(case_dir, link)
        guest = cls.__new__(cls)
        guest.split = "single"
        guest.sweep_dir = staging_dir
        guest._rows = []
        guest.ids = []
        guest.sdf_source = {}
        guest.norm = empty_norm()
        return guest

    def _read_bin(self, case_id: str, name: str, nx: int, ny: int) -> np.ndarray:
        path = self.sweep_dir / "cases" / case_id / f"{name}.f32"
        raw = np.fromfile(path, dtype=np.float32)
        if raw.size != nx * ny:
            raise ValueError(f"bin {path} size {raw.size} != {nx}*{ny}")
        if not np.all(np.isfinite(raw)):
            raise ValueError(f"bin {path} has non-finite values")
        return raw.reshape(ny, nx)

    def _raw_sample(self, row: dict) -> tuple[np.ndarray, np.ndarray]:
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
        for name in LBM_BIN_ORDER:
            path = self.sweep_dir / "cases" / case_id / f"{name}.f32"
            if name == "sdf" and not path.exists():
                continue
            bins[name] = self._read_bin(case_id, name, nx, ny)
        obstacle = resample_label(bins["obstacle"])
        fluid = 1.0 - obstacle
        alpha = np.full((NY, NX), float(row.get("alpha_deg", 0.0)), dtype=np.float32)
        logre = np.full((NY, NX), log_re, dtype=np.float32)
        if "sdf" in bins:
            sdf = np.clip(clean_finite(resample_continuous(bins["sdf"]), 3.0), -SDF_CLIP, SDF_CLIP)
        else:
            sdf = np.clip(sdf_from_mask(obstacle), -SDF_CLIP, SDF_CLIP)
        x = np.stack([sdf, obstacle, alpha, logre]).astype(np.float32)
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
        y = np.stack([um, vm, cp, vort, tke.astype(np.float32), recirc]).astype(np.float32)
        y = (y * fluid).astype(np.float32)
        return x, y

    def _load_all_raw(self) -> tuple[list[np.ndarray], list[np.ndarray]]:
        xs, ys = [], []
        for r in self._rows:
            x, y = self._raw_sample(r)
            xs.append(x)
            ys.append(y)
        return xs, ys

    def __len__(self) -> int:
        return len(self._rows)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        row = self._rows[idx]
        raw_x, raw_y = self._raw_sample(row)
        x, y = normalize_sample(raw_x, raw_y, self.norm)
        fluid = (raw_x[1] < 0.5).astype(np.float32)[None]
        return torch.from_numpy(x), torch.from_numpy(y), torch.from_numpy(fluid)
