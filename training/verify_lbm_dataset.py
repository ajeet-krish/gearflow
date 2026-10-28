"""Read only verification gate for LBM sweep datasets (protocol V0 to V7).

Scope is LBM sweep data only (never analytic shards). This script certifies a
merged sweep directory (manifest.jsonl plus case bins) before any
training run. It never writes into the sweep directory and never launches a
Modal job. The only writes are a JSON report plus preview PNGs under a user
specified out directory (default inside the system temp dir, never the repo).

Layouts accepted per case: flat <sweep>/<case_id>/*.f32 (pilot compat) and
nested <sweep>/cases/<case_id>/*.f32 (preferred for new sweeps). Resolution
checks the flat path first, then the nested path. Pilot v1 rows without
sha_version default to sha 1, without ref_length default by body (cylinder
0.4, block 0.4, duct 0.4, airfoil chord 1.0), and without substitutes_for
default to null, each with an explicit per row compat warning.

Protocol sections:
  V0 manifest: every completed row has its case dir, required bins with exact
      sizes, finite values, and a sha256 over the schema ordered bins that
      matches the row. Substitute rows must carry the substitute flag and a
      target that exists in the manifest.
  V1 physics: adapter level checks through dataset_v2 conversions. Mask is
      binary, SDF sign is negative in solid and positive in fluid, solid cells
      read exactly zero in every output head, recirc agrees with the negative
      velocity mask on at least 99 pct of cells, converted Cp stays inside
      (-10, 10), converted vorticity stays inside (-20, 20), raw TKE is non
      negative, and RMS divergence on native grid fields stays below 0.01.
      Divergence is checked on native umean and vmean normalized by u_lattice,
      with isotropic spacing dx from domain_width over nx minus 1 and erosion
      scaled to the same physical distance as the legacy 10 cell coarse band.
      Native is used because bilinear resampling of 256 by 128 airfoil fields
      to 128 by 128 aliases LES fluctuations and smears the wall step, leaving
      resampled RMS near 0.09 even far from the wall while native interior is
      near 0.005. Duct bodies are exempt from the divergence fail and from the
      Cp saturation warn by design (confined 0.4 gap channel across 6 length
      plates gives a large streamwise pressure drop, so clipped Cp near 0.33
      is expected; the 16 cell channel height leaves no interior after a 10
      cell scale erosion, so the free field threshold does not apply).
  V2 trends: bluff body Cd falls as Re rises, airfoil Cd rises with alpha, and
      any sweep case matching a pilot pin reads within the stated tolerance.
      Pilot pins come from the Phase 10 pilot table and are reused as trend
      references only, not as pass bands for new geometries.
  V3 splits: deterministic 80/20 case split with zero shared ids.
  V4 norm: fitted std floors hold, the TKE degenerate rule is applied, an
      optional norm sidecar validates against the v2 schema, and optional
      frozen inputs compare byte for byte.
  V5 previews: one PNG per body family with fixed colorbars.
  V6 coverage: Re coverage report. A sweep with no completed bluff body case
      at Re 100 is flagged as an extrapolation risk (warning only).
  V7 gate: exit 0 means TRAIN_APPROVED, exit 2 means DATA_FAILURE (V0, V2, V3
      findings), exit 3 means ADAPTER_FAILURE (V1, V4, V5 findings). When data
      and adapter failures co-occur, the exit code is ADAPTER_FAILURE and both
      lists are preserved in the report gate section.

Usage:
    python training/verify_lbm_dataset.py <sweep_dir> [--out DIR]
        [--norm PATH] [--frozen-norm PATH] [--train-frac F]
"""

import argparse
import hashlib
import json
import struct
import sys
import tempfile
import zlib
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

from dataset_v2 import (
    CP_CLIP,
    DX,
    DY,
    FREESTREAM,
    LBM_BIN_ORDER,
    NORM_SCHEMA,
    SDF_CLIP,
    TKE_STD_FLOOR,
    VORT_CLIP,
    canonical_norm_json,
    clean_finite,
    fit_norm,
    log_re_of,
    resample_continuous,
    resample_label,
    sdf_from_mask,
    split_case_ids,
)
from merge_sweep import bin_order_for, recompute_sha

EXIT_OK = 0
EXIT_DATA = 2
EXIT_ADAPTER = 3

REF_LENGTH_BY_BODY = {"cylinder": 0.4, "block": 0.4, "duct": 0.4}
AIRFOIL_REF_LENGTH = 1.0


def _default_ref_length(body: object) -> float | None:
    lowered = str(body or "").lower()
    if lowered in REF_LENGTH_BY_BODY:
        return REF_LENGTH_BY_BODY[lowered]
    if lowered.startswith("naca") or "airfoil" in lowered:
        return AIRFOIL_REF_LENGTH
    return None


def _resolve_case_dir(sweep_dir: Path, case_id: str) -> Path:
    """Resolve a case directory, flat first for pilot compat.

    Precedence: <sweep>/<case_id>/ is checked first (pilot flat layout),
    then <sweep>/cases/<case_id>/ (preferred for new sweeps). New sweeps
    should use the nested layout; flat remains accepted so the pilot
    dataset verifies without rewrites. Returns the nested path when
    neither candidate holds bins so callers report a single stable path.
    """
    flat = sweep_dir / case_id
    nested = sweep_dir / "cases" / case_id
    if (flat / "umean.f32").is_file():
        return flat
    if (nested / "umean.f32").is_file():
        return nested
    if flat.is_dir():
        return flat
    return nested


def _make_shim(sweep_dir: Path) -> object:
    """Build an adapter shim that reads both flat and nested layouts.

    The stock dataset adapter only reads <sweep>/cases/<case_id>/, so
    this shim overrides _read_bin and _raw_sample with layout aware
    equivalents that resolve through _resolve_case_dir. Conversion math
    mirrors dataset_v2.LbmV2Dataset._raw_sample exactly.
    """
    shim = _adapter()
    shim.sweep_dir = sweep_dir  # type: ignore[attr-defined]

    def _patched_read(case_id: str, name: str, nx: int, ny: int) -> np.ndarray:
        case_dir = _resolve_case_dir(sweep_dir, str(case_id))
        path = case_dir / f"{name}.f32"
        raw = np.fromfile(str(path), dtype=np.float32)
        if raw.size != nx * ny:
            raise ValueError(f"bin {path} size {raw.size} != {nx}*{ny}")
        if not np.all(np.isfinite(raw)):
            raise ValueError(f"bin {path} has non-finite values")
        return raw.reshape(ny, nx)

    def _patched_raw(row: dict) -> tuple[np.ndarray, np.ndarray]:
        case_id = str(row["case_id"])
        nx, ny = int(row["nx"]), int(row["ny"])
        u_ref = float(row["u_lattice"])
        ref_len = float(row["ref_length"])
        if not np.isfinite(u_ref) or u_ref <= 0.0:
            raise ValueError(f"case {case_id} has bad u_lattice {row.get('u_lattice')!r}")
        if not np.isfinite(ref_len) or ref_len <= 0.0:
            raise ValueError(f"case {case_id} has bad ref_length {row.get('ref_length')!r}")
        log_re = log_re_of({"id": case_id, "Re": row.get("re", row.get("Re", None))})
        case_dir = _resolve_case_dir(sweep_dir, case_id)
        bins: dict[str, np.ndarray] = {}
        for name in LBM_BIN_ORDER:
            path = case_dir / f"{name}.f32"
            if name == "sdf" and not path.exists():
                continue
            bins[name] = _patched_read(case_id, name, nx, ny)
        obstacle = resample_label(bins["obstacle"])
        fluid = 1.0 - obstacle
        alpha = np.full((128, 128), float(row.get("alpha_deg", 0.0)), dtype=np.float32)
        logre = np.full((128, 128), log_re, dtype=np.float32)
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

    shim._read_bin = _patched_read  # type: ignore[attr-defined]
    shim._raw_sample = _patched_raw  # type: ignore[attr-defined]
    return shim

REPORT_SCHEMA = "gearflow-verify/v1"
SHA_VERSION_DEFAULT = 1
MASK_TOL = 1e-6
SDF_TOL = 1e-6
TKE_NEG_TOL = 1e-6
RECIRC_AGREE_MIN = 0.99
DIV_RMS_MAX = 0.01
CLIP_SAT_WARN_FRAC = 0.01
INPUT_STD_FLOOR = 1e-6
TREND_ABS_TOL = 0.05
TREND_REL_TOL = 0.05
PIN_ABS_TOL = 0.05
PIN_REL_TOL = 0.15
ERODE_ITERS = 10
U_PREVIEW_RANGE = (0.0, 1.5)
BLUFF_BODIES = ("cylinder", "block")
DUCT_BODIES = ("duct",)

PILOT_PINS: dict[tuple[str, float, float], float] = {
    ("cylinder", 20.0, 0.0): 2.7720,
    ("cylinder", 40.0, 0.0): 2.0618,
    ("cylinder", 60.0, 0.0): 1.7770,
    ("block", 40.0, 0.0): 2.3447,
    ("block", 60.0, 0.0): 2.0291,
    ("naca0012", 100.0, 0.0): 0.1841,
    ("naca0012", 100.0, 4.0): 0.2058,
    ("naca0012", 100.0, 6.0): 0.2405,
    ("naca2412", 100.0, 6.0): 0.2439,
    ("duct", 40.0, 0.0): 7.3499,
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_manifest_rows(path: Path) -> list[dict]:
    rows = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _re_of(row: dict) -> float | None:
    raw = row.get("re", row.get("Re", None))
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(value) or value <= 0.0:
        return None
    return value


def _load_bin(case_dir: Path, name: str, nx: int, ny: int) -> np.ndarray:
    path = case_dir / f"{name}.f32"
    raw = np.fromfile(str(path), dtype=np.float32)
    if raw.size != nx * ny:
        raise ValueError(f"bin {path} size {raw.size} != {nx}*{ny}")
    return raw.reshape(ny, nx)


def _finite_blob_ok(path: Path) -> bool:
    try:
        blob = path.read_bytes()
    except OSError:
        return False
    count = len(blob) // 4
    if count * 4 != len(blob) or count == 0:
        return False
    try:
        vals = struct.unpack(f"<{count}f", blob)
    except struct.error:
        return False
    return all(v == v and v not in (float("inf"), float("-inf")) for v in vals)


def _adapter() -> object:
    from dataset_v2 import LbmV2Dataset

    shim = LbmV2Dataset.__new__(LbmV2Dataset)
    return shim


def _erode(mask: np.ndarray, iters: int) -> np.ndarray:
    eroded = mask.copy()
    for _ in range(iters):
        inner = eroded[1:-1, 1:-1] & eroded[:-2, 1:-1] & eroded[2:, 1:-1]
        inner = inner & eroded[1:-1, :-2] & eroded[1:-1, 2:]
        eroded[1:-1, 1:-1] = inner
        eroded[0, :] = False
        eroded[-1, :] = False
        eroded[:, 0] = False
        eroded[:, -1] = False
    return eroded


def _domain_width_of(row: dict) -> float | None:
    for key in ("domain_width", "width", "domainWidth"):
        raw = row.get(key, None)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if np.isfinite(value) and value > 0.0:
            return value
    return None


def _native_erode_iters(dx_nat: float) -> int:
    import math

    target = float(ERODE_ITERS * max(DX, DY))
    if not np.isfinite(dx_nat) or dx_nat <= 0.0:
        return ERODE_ITERS
    return max(1, int(math.ceil(target / dx_nat)))


def _native_div_rms(
    u_norm: np.ndarray, v_norm: np.ndarray, fluid: np.ndarray, dx_nat: float
) -> tuple[float, int, int]:
    dudx = np.empty_like(u_norm, dtype=np.float32)
    dvdy = np.empty_like(u_norm, dtype=np.float32)
    dudx[:, 1:-1] = (u_norm[:, 2:] - u_norm[:, :-2]) / (2.0 * dx_nat)
    dudx[:, 0] = (u_norm[:, 1] - u_norm[:, 0]) / dx_nat
    dudx[:, -1] = (u_norm[:, -1] - u_norm[:, -2]) / dx_nat
    dvdy[1:-1, :] = (v_norm[2:, :] - v_norm[:-2, :]) / (2.0 * dx_nat)
    dvdy[0, :] = (v_norm[1, :] - v_norm[0, :]) / dx_nat
    dvdy[-1, :] = (v_norm[-1, :] - v_norm[-2, :]) / dx_nat
    iters = _native_erode_iters(float(dx_nat))
    interior = _erode(fluid, iters)
    cells = interior & np.isfinite(dudx) & np.isfinite(dvdy)
    count = int(cells.sum())
    if count == 0:
        return float("inf"), 0, iters
    div = (dudx + dvdy)[cells]
    return float(np.sqrt(np.mean(div.astype(np.float64) ** 2))), count, iters


def _colormap(t: np.ndarray) -> np.ndarray:
    stops = np.array(
        [
            [13.0, 32.0, 120.0],
            [30.0, 120.0, 200.0],
            [60.0, 200.0, 190.0],
            [240.0, 200.0, 60.0],
            [180.0, 30.0, 30.0],
        ]
    )
    pos = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
    clipped = np.clip(t, 0.0, 1.0)
    rgb = np.empty(t.shape + (3,), dtype=np.float64)
    for channel in range(3):
        rgb[..., channel] = np.interp(clipped, pos, stops[:, channel])
    return np.clip(rgb, 0.0, 255.0).astype(np.uint8)


def _write_png_rgb(path: Path, rgb: np.ndarray) -> None:
    height, width, _ = rgb.shape
    raw = b"".join(b"\x00" + np.ascontiguousarray(rgb[y]).tobytes() for y in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        out = struct.pack(">I", len(data)) + tag + data
        out += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def v0_check_manifest(sweep_dir: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    manifest_path = sweep_dir / "manifest.jsonl"
    if not manifest_path.is_file():
        return {"errors": [f"manifest missing: {manifest_path}"], "rows": [], "good": []}
    try:
        rows = _read_manifest_rows(manifest_path)
    except (OSError, ValueError) as exc:
        return {"errors": [f"manifest unreadable: {exc}"], "rows": [], "good": []}
    if not rows:
        return {"errors": ["manifest holds no rows"], "rows": [], "good": []}
    by_id: dict[str, dict] = {}
    for row in rows:
        case_id = str(row.get("case_id", ""))
        if not case_id:
            errors.append("row without case_id")
            continue
        if case_id in by_id:
            errors.append(f"duplicate case_id {case_id}")
            continue
        by_id[case_id] = row
    counts = {"total": len(rows), "completed": 0, "diverged": 0, "setup_error": 0}
    good: list[dict] = []
    for case_id, row in by_id.items():
        status = str(row.get("status", "completed"))
        if "sha_version" not in row or row.get("sha_version") is None:
            warnings.append(f"{case_id}: compat default sha_version to 1 (pilot v1 row without sha_version)")
            row["sha_version"] = 1
        try:
            version = int(row.get("sha_version", SHA_VERSION_DEFAULT))
        except (TypeError, ValueError):
            errors.append(f"{case_id}: bad sha_version")
            continue
        if "substitutes_for" not in row:
            if version == 1:
                warnings.append(f"{case_id}: compat default substitutes_for to null (pilot v1 row without substitutes_for)")
                row["substitutes_for"] = None
            else:
                warnings.append(f"{case_id}: compat default substitutes_for to null (sha v2 row without substitutes_for)")
                row["substitutes_for"] = None
        if row.get("ref_length") is None:
            if version == 1:
                default_len = _default_ref_length(row.get("body", ""))
                if default_len is None:
                    if status in ("completed",):
                        errors.append(f"{case_id}: missing ref_length")
                else:
                    warnings.append(
                        f"{case_id}: compat default ref_length to {default_len} "
                        f"for body {str(row.get('body', ''))!r} (pilot v1 row without ref_length)"
                    )
                    row["ref_length"] = default_len
            else:
                pass
        if status == "completed":
            counts["completed"] += 1
        elif status == "diverged":
            counts["diverged"] += 1
            continue
        elif status == "setup_error":
            counts["setup_error"] += 1
            continue
        else:
            errors.append(f"{case_id}: unknown status {status!r}")
            continue
        for key in ("nx", "ny", "u_lattice", "ref_length"):
            if row.get(key) is None:
                errors.append(f"{case_id}: missing {key}")
        if _re_of(row) is None:
            errors.append(f"{case_id}: missing or non positive Re")
        if (
            row.get("nx") is None
            or row.get("ny") is None
            or row.get("u_lattice") is None
            or row.get("ref_length") is None
            or _re_of(row) is None
        ):
            continue
        target = row.get("substitutes_for")
        if target is not None and row.get("substitute") is not True:
            errors.append(f"{case_id}: substitute unflagged (substitutes_for set without substitute true)")
        if target is not None and str(target) not in by_id:
            errors.append(f"{case_id}: substitute target {target!r} missing from manifest")
        try:
            nx = int(row["nx"])
            ny = int(row["ny"])
        except (KeyError, TypeError, ValueError):
            continue
        case_dir = _resolve_case_dir(sweep_dir, case_id)
        if not case_dir.is_dir():
            errors.append(f"{case_id}: missing case dir")
            continue
        expect = nx * ny * 4
        row_ok = True
        for name in bin_order_for(version):
            blob_path = case_dir / name
            if not blob_path.is_file():
                errors.append(f"{case_id}: missing bin {name}")
                row_ok = False
                continue
            try:
                size = blob_path.stat().st_size
            except OSError as exc:
                errors.append(f"{case_id}: unreadable bin {name}: {exc}")
                row_ok = False
                continue
            if size != expect:
                errors.append(f"{case_id}: size mismatch {name}: {size} != {expect}")
                row_ok = False
            elif not _finite_blob_ok(blob_path):
                errors.append(f"{case_id}: non-finite values in {name}")
                row_ok = False
        if not row_ok:
            continue
        if not row.get("sha256"):
            errors.append(f"{case_id}: missing sha256")
            continue
        try:
            actual = recompute_sha(case_dir, version)
        except OSError as exc:
            errors.append(f"{case_id}: unreadable bin during sha: {exc}")
            continue
        if actual != row.get("sha256"):
            errors.append(f"{case_id}: sha256 mismatch")
            continue
        if version == 1 and (case_dir / "sdf.f32").is_file():
            warnings.append(f"{case_id}: extra sdf.f32 bin present under sha v1 (sdf_source lbm)")
        good.append(row)
    return {
        "errors": errors,
        "warnings": warnings,
        "rows": rows,
        "good": good,
        "counts": counts,
        "sha_ok": len(good),
    }


def v1_check_physics(sweep_dir: Path, rows: list[dict]) -> dict:
    failures: list[str] = []
    warnings: list[str] = []
    cases: dict[str, dict] = {}
    shim = _make_shim(sweep_dir)
    for row in rows:
        case_id = str(row["case_id"])
        nx = int(row["nx"])
        ny = int(row["ny"])
        u_ref = float(row["u_lattice"])
        ref_len = float(row["ref_length"])
        case_dir = _resolve_case_dir(sweep_dir, case_id)
        bins: dict[str, np.ndarray] = {}
        for name in LBM_BIN_ORDER:
            path = case_dir / f"{name}.f32"
            if name == "sdf" and not path.exists():
                continue
            bins[name] = _load_bin(case_dir, name, nx, ny)
        obstacle = bins["obstacle"]
        if not bool((((np.abs(obstacle) < MASK_TOL) | (np.abs(obstacle - 1.0) < MASK_TOL)).all())):
            failures.append(f"{case_id}: mask not binary")
            continue
        solid = obstacle > 0.5
        fluid = ~solid
        sdf_source = "lbm" if "sdf" in bins else "derived_mask"
        if "sdf" in bins:
            sdf = bins["sdf"]
            bad_solid = bool((sdf[solid] > SDF_TOL).any()) if solid.any() else False
            bad_fluid = bool((sdf[fluid] < -SDF_TOL).any()) if fluid.any() else False
            flat = bool(
                (np.abs(sdf[solid]).mean() < SDF_TOL if solid.any() else True)
                or (np.abs(sdf[fluid]).mean() < SDF_TOL if fluid.any() else True)
            )
            if bad_solid or bad_fluid or flat:
                failures.append(f"{case_id}: SDF sign violated (negative in solid, positive in fluid)")
                continue
        if float(bins["tke"].min()) < -TKE_NEG_TOL:
            failures.append(f"{case_id}: negative TKE")
            continue
        cp_conv = bins["pmean"] / (0.5 * u_ref * u_ref)
        vort_conv = bins["omegamean"] * ref_len / u_ref
        if not bool(np.all(np.isfinite(cp_conv))) or not bool(np.all(np.isfinite(vort_conv))):
            failures.append(f"{case_id}: non-finite converted Cp or vorticity")
            continue
        body_name = str(row.get("body", ""))
        is_duct = body_name.lower() in DUCT_BODIES
        for label, conv, clip in (("Cp", cp_conv, CP_CLIP), ("vorticity", vort_conv, VORT_CLIP)):
            sat = float((((np.abs(conv) >= clip) & fluid).sum()) / max(int(fluid.sum()), 1))
            if sat <= CLIP_SAT_WARN_FRAC:
                continue
            if is_duct and label == "Cp":
                warnings.append(
                    f"{case_id}: duct Cp saturation {sat:.3f} exempt by design "
                    f"(confined channel pressure drop, adapter clip plus minus {clip} unchanged)"
                )
                continue
            warnings.append(f"{case_id}: {label} clip saturation {sat:.3f} above {clip}")
        try:
            raw_x, raw_y = shim._raw_sample(row)
        except (ValueError, KeyError) as exc:
            failures.append(f"{case_id}: adapter raw sample failed: {exc}")
            continue
        solid128 = raw_x[1] > 0.5
        fluid128 = ~solid128
        solid_max = float(np.abs(raw_y[:, solid128]).max()) if solid128.any() else 0.0
        if solid_max != 0.0:
            failures.append(f"{case_id}: solid cells not exactly zero (max {solid_max})")
            continue
        pred = ((bins["umean"] < 0.0) & fluid).astype(np.float32)
        actual = (bins["recirc"] > 0.5).astype(np.float32)
        agree = float((pred == actual).mean())
        if agree < RECIRC_AGREE_MIN:
            failures.append(f"{case_id}: recirc agreement {agree:.4f} below {RECIRC_AGREE_MIN}")
            continue
        domain_width = _domain_width_of(row)
        if domain_width is None:
            lowered = body_name.lower()
            if lowered.startswith("naca") or "airfoil" in lowered:
                domain_width = 2.55
            else:
                domain_width = 4.0
            warnings.append(
                f"{case_id}: compat default domain_width to {domain_width} "
                f"for native divergence (row without domain_width)"
            )
        dx_nat = float(domain_width) / float(max(int(nx) - 1, 1))
        u_native = bins["umean"].astype(np.float64) / float(u_ref)
        v_native = bins["vmean"].astype(np.float64) / float(u_ref)
        div_rms, div_cells, div_iters = _native_div_rms(
            u_native.astype(np.float32), v_native.astype(np.float32), fluid, dx_nat
        )
        div_exempt = False
        if is_duct:
            warnings.append(
                f"{case_id}: duct divergence exempt by design "
                f"(confined 0.4 gap channel, 16 cell height, native rms {div_rms:.4f} "
                f"cells {div_cells} iters {div_iters} does not use free field {DIV_RMS_MAX})"
            )
            div_exempt = True
        elif not np.isfinite(div_rms) or div_rms >= DIV_RMS_MAX:
            failures.append(f"{case_id}: native RMS divergence {div_rms:.4f} at or above {DIV_RMS_MAX}")
            continue
        if not bool(np.all(np.isfinite(raw_y))) or not bool(np.all(np.isfinite(raw_x))):
            failures.append(f"{case_id}: non-finite adapter raw sample")
            continue
        out_max = {
            "cp": float(np.abs(raw_y[2][fluid128]).max()) if fluid128.any() else 0.0,
            "vorticity": float(np.abs(raw_y[3][fluid128]).max()) if fluid128.any() else 0.0,
        }
        if out_max["cp"] > CP_CLIP or out_max["vorticity"] > VORT_CLIP:
            failures.append(f"{case_id}: adapter output outside clip bounds")
            continue
        cases[case_id] = {
            "sdf_source": sdf_source,
            "recirc_agreement": agree,
            "div_rms": div_rms,
            "div_cells": div_cells,
            "div_grid": "native",
            "div_dx": dx_nat,
            "div_iters": div_iters,
            "div_exempt": div_exempt,
            "max_abs_cp": out_max["cp"],
            "max_abs_vorticity": out_max["vorticity"],
        }
    return {"failures": failures, "warnings": warnings, "cases": cases}


def _is_airfoil(body: str) -> bool:
    lowered = body.lower()
    return lowered.startswith("naca") or "airfoil" in lowered


def v2_check_trends(rows: list[dict]) -> dict:
    failures: list[str] = []
    warnings: list[str] = []
    with_cd = [r for r in rows if r.get("cd_mean") is not None]
    try:
        for row in with_cd:
            float(row["cd_mean"])
    except (TypeError, ValueError):
        return {"failures": ["cd_mean not numeric"], "warnings": warnings, "orderings": []}
    if not with_cd:
        return {"failures": [], "warnings": ["trends skipped: no cd_mean in manifest rows"], "orderings": []}
    orderings: list[dict] = []
    bluff_groups: dict[tuple[str, float], list[dict]] = {}
    foil_groups: dict[tuple[str, float], list[dict]] = {}
    for row in with_cd:
        body = str(row.get("body", ""))
        re = float(_re_of(row))
        alpha = float(row.get("alpha_deg", 0.0))
        key = (body.lower(), round(alpha, 6)) if not _is_airfoil(body) else (body.lower(), round(re, 6))
        target = foil_groups if _is_airfoil(body) else bluff_groups
        target.setdefault(key, []).append(row)
    for (body, alpha), group in sorted(bluff_groups.items()):
        ordered = sorted(group, key=lambda r: float(_re_of(r)))
        if len({float(_re_of(r)) for r in ordered}) < 2:
            continue
        ok = True
        for prev, nxt in zip(ordered, ordered[1:]):
            prev_cd = float(prev["cd_mean"])
            nxt_cd = float(nxt["cd_mean"])
            tol = max(TREND_ABS_TOL, TREND_REL_TOL * abs(prev_cd))
            if nxt_cd > prev_cd + tol:
                failures.append(
                    f"bluff Cd rises with Re: {body} Re {prev['re']} Cd {prev_cd} "
                    f"to Re {nxt['re']} Cd {nxt_cd} (tol {tol:.3f})"
                )
                ok = False
        orderings.append(
            {"kind": "bluff_cd_vs_re", "body": body, "alpha_deg": alpha, "holds": ok, "n": len(ordered)}
        )
    for (body, re), group in sorted(foil_groups.items()):
        ordered = sorted(group, key=lambda r: float(r.get("alpha_deg", 0.0)))
        if len({float(r.get("alpha_deg", 0.0)) for r in ordered}) < 2:
            continue
        ok = True
        for prev, nxt in zip(ordered, ordered[1:]):
            prev_cd = float(prev["cd_mean"])
            nxt_cd = float(nxt["cd_mean"])
            tol = max(TREND_ABS_TOL, TREND_REL_TOL * abs(prev_cd))
            if nxt_cd < prev_cd - tol:
                failures.append(
                    f"airfoil Cd falls with alpha: {body} Re {re} alpha {prev.get('alpha_deg')} "
                    f"Cd {prev_cd} to alpha {nxt.get('alpha_deg')} Cd {nxt_cd} (tol {tol:.3f})"
                )
                ok = False
        orderings.append(
            {"kind": "foil_cd_vs_alpha", "body": body, "re": re, "holds": ok, "n": len(ordered)}
        )
    pins_checked = 0
    for row in with_cd:
        key = (str(row.get("body", "")).lower(), float(_re_of(row)), float(row.get("alpha_deg", 0.0)))
        if key in PILOT_PINS:
            pins_checked += 1
            pin = PILOT_PINS[key]
            cd = float(row["cd_mean"])
            tol = max(PIN_ABS_TOL, PIN_REL_TOL * abs(pin))
            if abs(cd - pin) > tol:
                failures.append(
                    f"pilot pin miss: {row['case_id']} Cd {cd} vs pin {pin} (tol {tol:.3f})"
                )
    orderings.append({"kind": "pilot_pins", "checked": pins_checked, "holds": True})
    return {"failures": failures, "warnings": warnings, "orderings": orderings}


def v3_check_splits(case_ids: list[str], train_frac: float) -> dict:
    if len(case_ids) < 2:
        return {"failures": ["fewer than 2 completed cases, cannot split"], "train": [], "val": []}
    try:
        train_ids, val_ids = split_case_ids(case_ids, train_frac)
    except ValueError as exc:
        return {"failures": [str(exc)], "train": [], "val": []}
    failures: list[str] = []
    if set(train_ids) & set(val_ids):
        failures.append("train and val splits share ids")
    if set(train_ids) | set(val_ids) != set(case_ids):
        failures.append("split union does not cover completed cases")
    repeat_train, repeat_val = split_case_ids(case_ids, train_frac)
    if repeat_train != train_ids or repeat_val != val_ids:
        failures.append("split is not deterministic")
    return {"failures": failures, "train": train_ids, "val": val_ids}


def v4_check_norm(
    sweep_dir: Path,
    rows_by_id: dict[str, dict],
    train_ids: list[str],
    norm_path: Path | None,
    frozen_path: Path | None,
) -> dict:
    failures: list[str] = []
    warnings: list[str] = []
    info: dict[str, object] = {}
    if not train_ids:
        return {"failures": [], "warnings": ["norm check skipped: no train split"], "info": info}
    shim = _make_shim(sweep_dir)
    raw_x: list[np.ndarray] = []
    raw_y: list[np.ndarray] = []
    try:
        for case_id in train_ids:
            x, y = shim._raw_sample(rows_by_id[case_id])
            raw_x.append(x)
            raw_y.append(y)
        norm = fit_norm(raw_x, raw_y, fitted_on=f"verify:{sweep_dir.name}:train")
    except (ValueError, KeyError) as exc:
        return {"failures": [f"norm fit failed: {exc}"], "warnings": warnings, "info": info}
    for key in ("sdf", "logRe"):
        std = float(norm["inputs"][key]["std"])
        if std < INPUT_STD_FLOOR:
            failures.append(f"input {key} std {std} below floor {INPUT_STD_FLOOR}")
    stacked = np.stack(raw_y).astype(np.float64)
    from dataset_v2 import V2_OUT_HEADS

    for i, name in enumerate(V2_OUT_HEADS):
        if name == "recirc":
            continue
        raw_std = float(stacked[:, i].std())
        entry = norm["outputs"][name]
        if name == "tke":
            if raw_std < TKE_STD_FLOOR:
                if not (entry.get("degenerate") is True and float(entry["std"]) == 1.0):
                    failures.append("TKE degenerate rule not applied")
            elif not (entry.get("degenerate") is False and float(entry["std"]) >= INPUT_STD_FLOOR):
                failures.append(f"TKE std {entry.get('std')} inconsistent with raw std {raw_std}")
        elif float(entry["std"]) < INPUT_STD_FLOOR:
            failures.append(f"output {name} std below floor")
    info["fitted_hash"] = hashlib.sha256(canonical_norm_json(norm).encode()).hexdigest()
    info["n_fit"] = len(train_ids)
    sidecar_path = norm_path or (sweep_dir / "norm.json")
    if sidecar_path is not None and Path(sidecar_path).is_file():
        try:
            sidecar = json.loads(Path(sidecar_path).read_text())
        except (OSError, ValueError) as exc:
            failures.append(f"norm sidecar unreadable: {exc}")
            sidecar = None
        if sidecar is not None:
            if sidecar.get("schema") != NORM_SCHEMA:
                failures.append(f"norm sidecar schema {sidecar.get('schema')!r} != {NORM_SCHEMA}")
            for key in ("inputs", "outputs", "clips"):
                if key not in sidecar:
                    failures.append(f"norm sidecar missing {key}")
            info["sidecar"] = str(sidecar_path)
    else:
        warnings.append("no norm sidecar present, fitted fresh")
    if frozen_path is not None:
        try:
            frozen = json.loads(Path(frozen_path).read_text())
        except (OSError, ValueError) as exc:
            failures.append(f"frozen norm unreadable: {exc}")
            frozen = None
        if frozen is not None:
            if frozen.get("schema") != NORM_SCHEMA:
                failures.append("frozen norm schema mismatch")
            elif not isinstance(frozen.get("inputs"), dict):
                failures.append("frozen norm missing inputs")
            else:
                try:
                    frozen_inputs = canonical_norm_json(frozen["inputs"])
                    fitted_inputs = canonical_norm_json(norm["inputs"])
                except (KeyError, TypeError, ValueError) as exc:
                    failures.append(f"frozen inputs unreadable: {exc}")
                else:
                    if frozen_inputs != fitted_inputs:
                        failures.append("frozen inputs differ byte for byte")
            info["frozen"] = str(frozen_path)
    return {"failures": failures, "warnings": warnings, "info": info}


def v5_write_previews(
    sweep_dir: Path, out_dir: Path, rows: list[dict], cases: dict[str, dict]
) -> dict:
    failures: list[str] = []
    previews: list[dict] = []
    preview_dir = out_dir / "previews"
    shim = _make_shim(sweep_dir)
    families: dict[str, list[dict]] = {}
    for row in rows:
        if str(row["case_id"]) in cases:
            families.setdefault(str(row.get("body", "unknown")), []).append(row)
    for family in sorted(families):
        picked = sorted(families[family], key=lambda r: str(r["case_id"]))[0]
        case_id = str(picked["case_id"])
        try:
            _, raw_y = shim._raw_sample(picked)
            field = raw_y[0].astype(np.float64)
            lo, hi = U_PREVIEW_RANGE
            t = (np.clip(field, lo, hi) - lo) / (hi - lo)
            rgb = _colormap(t)
            bar = _colormap(np.linspace(1.0, 0.0, rgb.shape[0]).reshape(-1, 1))
            bar = np.repeat(bar, 14, axis=1)
            gap = np.full((rgb.shape[0], 2, 3), 255, dtype=np.uint8)
            canvas = np.concatenate([rgb, gap, bar], axis=1)
            name = f"preview_{family}_meanU.png"
            _write_png_rgb(preview_dir / name, canvas)
            previews.append(
                {
                    "family": family,
                    "case_id": case_id,
                    "quantity": "meanU",
                    "vmin": lo,
                    "vmax": hi,
                    "file": f"previews/{name}",
                }
            )
        except (ValueError, KeyError, OSError) as exc:
            failures.append(f"{family}: preview failed: {exc}")
    return {"failures": failures, "previews": previews}


def v6_coverage(rows: list[dict]) -> dict:
    by_body: dict[str, list[float]] = {}
    for row in rows:
        re = _re_of(row)
        if re is None:
            continue
        by_body.setdefault(str(row.get("body", "unknown")), []).append(float(re))
    coverage = {body: sorted(set(res)) for body, res in sorted(by_body.items())}
    bluff_res = set()
    for body, res in coverage.items():
        if body.lower() in BLUFF_BODIES:
            bluff_res.update(res)
    risk = not any(abs(r - 100.0) < 1e-9 for r in bluff_res)
    note = (
        "no completed bluff body case at Re 100, treat higher Re as extrapolation risk"
        if risk
        else "Re 100 bluff body coverage present"
    )
    return {"coverage": coverage, "extrapolation_risk": risk, "note": note}


def verify_sweep(
    sweep_dir: Path,
    out_dir: Path,
    norm_path: Path | None = None,
    frozen_path: Path | None = None,
    train_frac: float = 0.8,
) -> tuple[dict, int]:
    v0 = v0_check_manifest(sweep_dir)
    data_failures: list[str] = [f"V0: {e}" for e in v0["errors"]]
    adapter_failures: list[str] = []
    warnings: list[str] = [f"V0: {w}" for w in v0.get("warnings", [])]
    good_rows: list[dict] = v0.get("good", [])
    v1 = v1_check_physics(sweep_dir, good_rows)
    adapter_failures.extend(f"V1: {e}" for e in v1["failures"])
    warnings.extend(f"V1: {w}" for w in v1["warnings"])
    ok_rows = [r for r in good_rows if str(r["case_id"]) in v1["cases"]]
    v2 = v2_check_trends(ok_rows)
    data_failures.extend(f"V2: {e}" for e in v2["failures"])
    warnings.extend(f"V2: {w}" for w in v2["warnings"])
    rows_by_id = {str(r["case_id"]): r for r in good_rows}
    v3 = v3_check_splits([str(r["case_id"]) for r in ok_rows], train_frac)
    data_failures.extend(f"V3: {e}" for e in v3["failures"])
    v4 = v4_check_norm(sweep_dir, rows_by_id, v3.get("train", []), norm_path, frozen_path)
    adapter_failures.extend(f"V4: {e}" for e in v4["failures"])
    warnings.extend(f"V4: {w}" for w in v4["warnings"])
    v5 = v5_write_previews(sweep_dir, out_dir, ok_rows, v1["cases"])
    adapter_failures.extend(f"V5: {e}" for e in v5["failures"])
    v6 = v6_coverage(ok_rows)
    if adapter_failures:
        status, exit_code = "ADAPTER_FAILURE", EXIT_ADAPTER
    elif data_failures:
        status, exit_code = "DATA_FAILURE", EXIT_DATA
    else:
        status, exit_code = "TRAIN_APPROVED", EXIT_OK
    report = {
        "schema": REPORT_SCHEMA,
        "sweep": str(sweep_dir),
        "generated_utc": _utc_now(),
        "status": status,
        "exit_code": exit_code,
        "v0_manifest": {
            "counts": v0.get("counts", {}),
            "sha_ok": v0.get("sha_ok", 0),
            "errors": v0["errors"],
        },
        "v1_physics": {
            "n_checked": len(good_rows),
            "n_ok": len(ok_rows),
            "cases": v1["cases"],
            "thresholds": {
                "recirc_agreement_min": RECIRC_AGREE_MIN,
                "div_rms_max": DIV_RMS_MAX,
                "cp_clip": CP_CLIP,
                "vorticity_clip": VORT_CLIP,
            },
        },
        "v2_trends": {
            "orderings": v2["orderings"],
            "tolerances": {
                "trend_abs": TREND_ABS_TOL,
                "trend_rel": TREND_REL_TOL,
                "pin_abs": PIN_ABS_TOL,
                "pin_rel": PIN_REL_TOL,
            },
        },
        "v3_splits": {"train": v3.get("train", []), "val": v3.get("val", []), "train_frac": train_frac},
        "v4_norm": v4["info"],
        "v5_previews": {"previews": v5["previews"], "fixed_colorbars": {"meanU": list(U_PREVIEW_RANGE)}},
        "v6_coverage": v6,
        "gate": {
            "data_failures": data_failures,
            "adapter_failures": adapter_failures,
            "warnings": warnings,
        },
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "verify_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report, exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read only LBM sweep verification gate.")
    parser.add_argument("sweep_dir")
    parser.add_argument("out_arg", nargs="?", default=None, help="output directory")
    parser.add_argument("--out", dest="out", default=None)
    parser.add_argument("--norm", default=None)
    parser.add_argument("--frozen-norm", default=None)
    parser.add_argument("--train-frac", type=float, default=0.8)
    args = parser.parse_args(argv)
    sweep_dir = Path(args.sweep_dir).resolve()
    out_raw = args.out or args.out_arg
    if out_raw:
        out_dir = Path(out_raw).resolve()
    else:
        out_dir = Path(tempfile.gettempdir()) / f"gearflow-verify-{sweep_dir.name}"
    if out_dir == sweep_dir or sweep_dir in out_dir.parents:
        print(f"verify: out dir {out_dir} must not live inside sweep dir", file=sys.stderr)
        return EXIT_DATA
    if not (sweep_dir / "manifest.jsonl").is_file():
        out_dir.mkdir(parents=True, exist_ok=True)
        report = {
            "schema": REPORT_SCHEMA,
            "sweep": str(sweep_dir),
            "generated_utc": _utc_now(),
            "status": "DATA_FAILURE",
            "exit_code": EXIT_DATA,
            "gate": {"data_failures": ["V0: manifest missing"], "adapter_failures": [], "warnings": []},
        }
        (out_dir / "verify_report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("verify: DATA_FAILURE (manifest missing)", file=sys.stderr)
        return EXIT_DATA
    try:
        report, exit_code = verify_sweep(
            sweep_dir,
            out_dir,
            norm_path=Path(args.norm) if args.norm else None,
            frozen_path=Path(args.frozen_norm) if args.frozen_norm else None,
            train_frac=float(args.train_frac),
        )
    except (OSError, ValueError) as exc:
        print(f"verify: gate error: {exc}", file=sys.stderr)
        return EXIT_ADAPTER
    counts = report["v0_manifest"]["counts"]
    print(
        f"verify: {report['status']} exit={exit_code} "
        f"completed={counts.get('completed', 0)} ok={report['v1_physics']['n_ok']} "
        f"data_failures={len(report['gate']['data_failures'])} "
        f"adapter_failures={len(report['gate']['adapter_failures'])} "
        f"extrapolation_risk={report['v6_coverage']['extrapolation_risk']} "
        f"report={out_dir / 'verify_report.json'}"
    )
    for failure in report["gate"]["data_failures"] + report["gate"]["adapter_failures"]:
        print(f"verify: {failure}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
