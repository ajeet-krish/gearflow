"""V2 parity golden generator: fixed inputs through torch and ONNX Runtime CPU.

Builds three fixed inputs (all zeros, seeded 7 random, one real LBM pilot
case via the v2 adapter), runs torch always and ONNX Runtime CPU when this
env can execute InstanceNormalization-18, then writes per case dirs under
fixtures/surrogate-v2/ with input.f32 plus expected_torch.f32 plus
expected_onnx.f32 for the zeros case only on the ORT path plus a top level golden.json describing
shapes, sha256 hashes, norm sha, base, opset, torch vs onnx max err, and the
1e-4 tolerance. Skip path total stays under 2 MiB.

Committed capable layout decision (C-5): when ORT can execute
InstanceNormalization, only the zeros case persists expected_onnx.f32. All
three cases still run through ORT in a temp dir and contribute to
torchVsOnnxMaxErr, but only zeros is written, so the committed set stays one
extra 384 KiB file (about 2.3 MiB total) instead of three extra files (about
3.0 MiB). The zeros input is the canonical fixed point (deterministic,
dense, no sampling noise), so one persisted onnx output proves the graph
executes while torchVsOnnxMaxErr proves parity on all three. Skip path
totalBytes is pinned near 1969254; available path totalBytes is pinned near
2362xxx (skip plus one 393216 byte output plus the small golden.json delta)
and both are asserted in training/tests/test_golden_v2.py.

When ORT cannot execute InstanceNormalization in this env (known local
limitation), the generator still writes the
torch outputs and records the skip reason in golden.json instead of failing.

V3 companion (schema gearflow-surrogate-golden/v2): run_golden_v3 covers
the two output unet-v3 contract (spatial 1 by 10 by 128 by 128 plus aux 1
by 3). Torch runs both heads always, ORT runs both heads on every case
when available with separate spatial and aux maxima that must each clear
1e-4, torch spatial plus aux persist for all cases while only the zeros
case persists ONNX spatial plus aux. The available path budget is 3.6 MiB.

Checkpoint sources (first match wins): explicit --checkpoint plus --norm,
--run-id under training/checkpoints/v2/, or --synthetic for a seeded
random init plus default norm (provenance records synthetic). No Modal job
is launched; everything runs locally on CPU.
"""

import argparse
import datetime
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).parent
REPO = HERE.parent
V2_CHECKPOINT_ROOT = HERE / "checkpoints" / "v2"
V3_CHECKPOINT_ROOT = HERE / "checkpoints" / "v3"
PILOT_ROOT = REPO / "data" / "pilot"
GOLDEN_ROOT = REPO / "fixtures" / "surrogate-v2"
GOLDEN_ROOT_V3 = REPO / "fixtures" / "surrogate-v3"
NX = 128
NY = 128
V2_IN_CH = 4
V2_OUT_CH = 6
V2_BASE = 8
V2_OPSET = 18
V2_TOLERANCE = 1e-4
GOLDEN_BUDGET = 2 * 1024 * 1024
GOLDEN_ONNX_CASES = ("zeros",)
GOLDEN_AVAILABLE_BUDGET = 5 * 1024 * 1024 // 2
V3_IN_CH = 4
V3_OUT_CH = 10
V3_AUX_CH = 3
V3_BASE = 8
V3_OPSET = 18
V3_TOLERANCE = 1e-4
GOLDEN_SCHEMA_V1 = "gearflow-surrogate-golden/v1"
GOLDEN_SCHEMA_V2 = "gearflow-surrogate-golden/v2"
GOLDEN_V3_ONNX_CASES = ("zeros",)
GOLDEN_V3_AVAILABLE_BUDGET = int(3.6 * 1024 * 1024)
GOLDEN_V3_SKIP_BUDGET = 3 * 1024 * 1024
V3_SPATIAL_HEADS = (
    "meanU",
    "meanV",
    "cp",
    "vorticity",
    "tke",
    "recirc",
    "uCos",
    "uSin",
    "vCos",
    "vSin",
)
V3_AUX_HEADS = ("strouhalNorm", "explainedLogit", "harmonicValidLogit")
RANDOM_SEED = 7
GOLDEN_LBM_CASE = "naca0012_a04_re100"

sys.path.insert(0, str(HERE))

from dataset_v2 import empty_norm, normalize_sample, norm_hash  # noqa: E402
from export_onnx import ort_instancenorm_available  # noqa: E402
from model import UNetV2  # noqa: E402


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pilot_ref_length(case_id: str, body: str, override: float | None = None) -> tuple[float, str]:
    """Ref length for a pilot case plus a provenance note.

    Pilot meta.json carries no ref_length, so map by body: airfoils use the
    canonical chord 1.0; cylinder, block, and duct parse their size digits
    (hundredths, so 020 is 0.20) into diameter, side, or gap height.
    """
    if override is not None:
        if not np.isfinite(override) or override <= 0.0:
            raise SystemExit(f"golden: --ref-length must be positive finite, got {override!r}")
        return float(override), "explicit --ref-length override"
    if body.startswith("naca"):
        return 1.0, "airfoil chord is 1.0 by the canonical grid convention"
    tail = re.search(r"(\d{3})$", case_id)
    if tail is None:
        raise SystemExit(
            f"golden: cannot infer ref_length for case {case_id!r} "
            f"(body {body!r}); pass --ref-length explicitly"
        )
    size = int(tail.group(1)) / 100.0
    if body == "cylinder":
        return 2.0 * size, f"cylinder diameter from case id ({size} radius)"
    if body in ("block", "duct"):
        return size, f"{body} size from case id"
    raise SystemExit(
        f"golden: unknown pilot body {body!r} for case {case_id!r}; pass --ref-length explicitly"
    )


def load_bundle(args: argparse.Namespace) -> tuple[torch.nn.Module, dict, dict]:
    """Load (model, norm, provenance) from explicit paths, run id, or synthetic."""
    from dataset_v2 import load_norm_sidecar

    if args.synthetic:
        torch.manual_seed(args.seed)
        model = UNetV2(base=V2_BASE)
        norm = empty_norm()
        norm["fittedOn"] = "synthetic"
        provenance = {
            "source": "synthetic",
            "detail": f"seeded random init (seed {args.seed}) plus default norm, no Modal checkpoint",
        }
        return model, norm, provenance
    ckpt_path = args.checkpoint
    norm_path = args.norm
    if args.run_id is not None:
        ckpt_dir = V2_CHECKPOINT_ROOT / args.run_id
        ckpt_path = ckpt_path or (ckpt_dir / "best.pt")
        norm_path = norm_path or (ckpt_dir / "norm.json")
    if ckpt_path is None or norm_path is None:
        raise SystemExit(
            "golden: no checkpoint given; pass --checkpoint plus --norm, "
            "--run-id <id>, or --synthetic"
        )
    ckpt_path, norm_path = Path(ckpt_path), Path(norm_path)
    if not ckpt_path.exists():
        raise SystemExit(f"golden: checkpoint missing: {ckpt_path}")
    if not norm_path.exists():
        raise SystemExit(f"golden: norm sidecar missing: {norm_path}")
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    if ckpt.get("arch", None) != "unet-v2":
        raise SystemExit(
            f"golden: refusing checkpoint with arch {ckpt.get('arch')!r} "
            "(need 'unet-v2'; v1 checkpoints are rejected, never adapted)"
        )
    norm = load_norm_sidecar(norm_path)
    if norm_hash(norm) != norm_hash(ckpt["norm"]):
        raise SystemExit("golden: norm sidecar hash mismatch (sidecar is authoritative)")
    model = UNetV2(base=V2_BASE)
    model.load_state_dict(ckpt["model"])
    provenance = {
        "source": "checkpoint",
        "checkpoint": str(ckpt_path),
        "runId": str(ckpt.get("runId", "")),
    }
    return model, norm, provenance


def build_lbm_input(case_id: str, norm: dict, ref_override: float | None) -> tuple[np.ndarray, dict]:
    """Adapt one pilot LBM case to a normalized (1, 4, 128, 128) model input."""
    from dataset_v2 import LbmV2Dataset

    case_dir = PILOT_ROOT / case_id
    meta_path = case_dir / "meta.json"
    if not meta_path.exists():
        raise SystemExit(f"golden: pilot case missing: {case_id} (need {meta_path})")
    meta = json.loads(meta_path.read_text())
    if meta.get("status", "completed") != "completed":
        raise SystemExit(f"golden: pilot case {case_id} status is {meta.get('status')!r}, need completed")
    ref_length, ref_note = pilot_ref_length(case_id, str(meta.get("body", "")), ref_override)
    row = {
        "case_id": case_id,
        "nx": int(meta["nx"]),
        "ny": int(meta["ny"]),
        "u_lattice": float(meta["u_lattice"]),
        "ref_length": ref_length,
        "alpha_deg": float(meta.get("alpha_deg", 0.0)),
        "re": meta.get("re", meta.get("Re", None)),
    }
    with tempfile.TemporaryDirectory(prefix="golden-lbm-") as tmp:
        staging = Path(tmp)
        guest = LbmV2Dataset.staged_for_case(staging, case_dir)
        raw_x, raw_y = LbmV2Dataset._raw_sample(guest, row)
    sdf_bin = case_dir / "sdf.f32"
    sdf_source = "lbm" if sdf_bin.exists() else "derived_mask"
    model_x, _ = normalize_sample(raw_x, raw_y, norm)
    if not np.all(np.isfinite(model_x)):
        raise SystemExit(f"golden: normalized LBM input for {case_id} is not finite")
    info = {
        "description": (
            f"real LBM pilot case {case_id} (body {meta.get('body')}, "
            f"Re {meta.get('re')}) via the v2 adapter, normalized with the golden norm"
        ),
        "caseId": case_id,
        "refLength": ref_length,
        "refLengthNote": ref_note,
        "sdfSource": sdf_source,
    }
    return model_x[None].astype(np.float32), info


def build_inputs(norm: dict, seed: int, lbm_case: str, ref_override: float | None) -> list[dict]:
    torch.manual_seed(seed)
    rand = torch.randn(1, V2_IN_CH, NY, NX).numpy().astype(np.float32)
    lbm, lbm_info = build_lbm_input(lbm_case, norm, ref_override)
    return [
        {
            "name": "zeros",
            "description": "all zero model input (1, 4, 128, 128)",
            "input": np.zeros((1, V2_IN_CH, NY, NX), np.float32),
        },
        {
            "name": "randn_s7",
            "description": f"standard normal model input, torch manual seed {seed}",
            "input": rand,
        },
        {"name": f"lbm_{lbm_case}", "input": lbm, **lbm_info},
    ]


def write_f32(path: Path, array: np.ndarray) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(array, dtype=np.float32).tobytes()
    path.write_bytes(data)
    return sha256_bytes(data)


def run_golden(
    model: torch.nn.Module,
    norm: dict,
    provenance: dict,
    out_dir: Path,
    seed: int = RANDOM_SEED,
    lbm_case: str = GOLDEN_LBM_CASE,
    ref_override: float | None = None,
    tolerance: float = V2_TOLERANCE,
) -> dict:
    """Run the golden set and write fixtures; returns the golden.json dict."""
    model.eval()
    cases = build_inputs(norm, seed, lbm_case, ref_override)
    with torch.no_grad():
        torch_outs = [model(torch.from_numpy(c["input"])).numpy().astype(np.float32) for c in cases]

    available, reason = ort_instancenorm_available()
    onnx_outs: list[np.ndarray | None] = [None] * len(cases)
    max_err: float | None = None
    if available:
        import onnxruntime as ort

        with tempfile.TemporaryDirectory(prefix="golden-onnx-") as tmp:
            onnx_path = Path(tmp) / "golden.onnx"
            torch.onnx.export(
                model,
                torch.zeros(1, V2_IN_CH, NY, NX),
                str(onnx_path),
                input_names=["input"],
                output_names=["output"],
                dynamic_axes=None,
                opset_version=V2_OPSET,
                dynamo=False,
            )
            sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            for i, case in enumerate(cases):
                got = sess.run(["output"], {"input": case["input"]})[0].astype(np.float32)
                err = float(np.max(np.abs(torch_outs[i] - got)))
                max_err = err if max_err is None else max(max_err, err)
                onnx_outs[i] = got
        if max_err is None or not np.isfinite(max_err) or max_err > tolerance:
            raise SystemExit(f"golden: torch vs onnx max err {max_err} exceeds {tolerance}")
        print(f"golden: torch vs onnx max_err={max_err:.3e}")
    else:
        print(f"golden: onnx run skipped: {reason}")

    case_records = []
    onnx_keep = set(GOLDEN_ONNX_CASES)
    for i, case in enumerate(cases):
        case_dir = out_dir / case["name"]
        in_sha = write_f32(case_dir / "input.f32", case["input"])
        torch_sha = write_f32(case_dir / "expected_torch.f32", torch_outs[i])
        record: dict = {
            "name": case["name"],
            "description": case["description"],
            "input": {"file": f"{case['name']}/input.f32", "shape": [1, V2_IN_CH, NY, NX], "sha256": in_sha},
            "torch": {
                "file": f"{case['name']}/expected_torch.f32",
                "shape": [1, V2_OUT_CH, NY, NX],
                "sha256": torch_sha,
            },
            "onnx": None,
        }
        if onnx_outs[i] is not None and case["name"] in onnx_keep:
            onnx_sha = write_f32(case_dir / "expected_onnx.f32", onnx_outs[i])
            record["onnx"] = {
                "file": f"{case['name']}/expected_onnx.f32",
                "shape": [1, V2_OUT_CH, NY, NX],
                "sha256": onnx_sha,
            }
        if "caseId" in case:
            record["lbmCase"] = case["caseId"]
            record["refLength"] = case["refLength"]
            record["refLengthNote"] = case["refLengthNote"]
            record["sdfSource"] = case["sdfSource"]
        case_records.append(record)

    golden = {
        "schema": "gearflow-surrogate-golden/v1",
        "arch": "unet-v2",
        "base": V2_BASE,
        "opset": V2_OPSET,
        "tolerance": tolerance,
        "seed": seed,
        "normSha256": norm_hash(norm),
        "layout": "NCHW C-order float32, one sample per file",
        "onnxCases": list(GOLDEN_ONNX_CASES),
        "cases": case_records,
        "torchVsOnnxMaxErr": max_err,
        "onnx": {"available": available, "reason": "" if available else reason},
        "provenance": provenance,
        "generatedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "totalBytes": 0,
    }
    golden_path = out_dir / "golden.json"
    for _ in range(4):
        golden_path.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")
        total = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
        if golden["totalBytes"] == total:
            break
        golden["totalBytes"] = total
    else:
        raise SystemExit("golden: totalBytes did not converge")
    print(f"golden: wrote {out_dir} totalBytes={total}")
    budget = GOLDEN_AVAILABLE_BUDGET if available else GOLDEN_BUDGET
    if total >= budget:
        raise SystemExit(f"golden: total {total} bytes meets or exceeds the budget {budget}")
    return golden


def load_bundle_v3(args: argparse.Namespace) -> tuple[torch.nn.Module, dict, dict]:
    """Load a (v3 model, v3 norm, provenance) triple, mirroring load_bundle.

    Synthetic mode builds a seeded UNetV3 plus the default v3 norm.
    Checkpoint mode requires arch unet-v3 and a v3 schema sidecar with a
    matching norm hash, and rejects v1 and v2 checkpoints outright.
    """
    from dataset_v3 import empty_norm_v3, norm_hash_v3

    if args.synthetic:
        from model import UNetV3

        torch.manual_seed(args.seed)
        model = UNetV3(base=V3_BASE)
        norm = empty_norm_v3()
        norm["fittedOn"] = "synthetic"
        provenance = {
            "source": "synthetic",
            "detail": f"seeded random init (seed {args.seed}) plus default v3 norm, no Modal checkpoint",
        }
        return model, norm, provenance
    ckpt_path = args.checkpoint
    norm_path = args.norm
    if args.run_id is not None:
        ckpt_dir = V3_CHECKPOINT_ROOT / args.run_id
        ckpt_path = ckpt_path or (ckpt_dir / "best.pt")
        norm_path = norm_path or (ckpt_dir / "norm.json")
    if ckpt_path is None or norm_path is None:
        raise SystemExit(
            "golden: no checkpoint given; pass --checkpoint plus --norm, "
            "--run-id <id> with --arch unet-v3, or --synthetic"
        )
    ckpt_path, norm_path = Path(ckpt_path), Path(norm_path)
    if not ckpt_path.exists():
        raise SystemExit(f"golden: checkpoint missing: {ckpt_path}")
    if not norm_path.exists():
        raise SystemExit(f"golden: norm sidecar missing: {norm_path}")
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    if ckpt.get("arch", None) != "unet-v3":
        raise SystemExit(
            f"golden: refusing checkpoint with arch {ckpt.get('arch')!r} "
            "(need 'unet-v3'; v1 and v2 checkpoints are rejected, never adapted)"
        )
    norm = json.loads(Path(norm_path).read_text())
    if norm.get("schema") != "gearflow-surrogate-norm/v3":
        raise SystemExit(
            f"golden: norm schema must be gearflow-surrogate-norm/v3, got {norm.get('schema')!r}"
        )
    if norm_hash_v3(norm) != norm_hash_v3(ckpt["norm"]):
        raise SystemExit("golden: norm sidecar hash mismatch (sidecar is authoritative)")
    from model import UNetV3

    model = UNetV3(base=V3_BASE)
    model.load_state_dict(ckpt["model"])
    provenance = {
        "source": "checkpoint",
        "checkpoint": str(ckpt_path),
        "runId": str(ckpt.get("runId", "")),
    }
    return model, norm, provenance


def build_lbm_input_v3(norm: dict, case_id: str, ref_override: float | None) -> tuple[np.ndarray, dict]:
    """Adapt one pilot LBM case to a v3 model input using the v2 geometry path.

    The 4 input channels are identical between v2 and v3, and the pilot
    sweep predates harmonic bins, so geometry comes from the v2 adapter
    while input normalization reads the v3 norm input section only. The
    returned provenance matches the v2 record shape.
    """
    from dataset_v2 import LbmV2Dataset, normalize_sample

    case_dir = PILOT_ROOT / case_id
    meta_path = case_dir / "meta.json"
    if not meta_path.exists():
        raise SystemExit(f"golden: pilot case missing: {case_id} (need {meta_path})")
    meta = json.loads(meta_path.read_text())
    if meta.get("status", "completed") != "completed":
        raise SystemExit(f"golden: pilot case {case_id} status is {meta.get('status')!r}, need completed")
    ref_length, ref_note = pilot_ref_length(case_id, str(meta.get("body", "")), ref_override)
    row = {
        "case_id": case_id,
        "nx": int(meta["nx"]),
        "ny": int(meta["ny"]),
        "u_lattice": float(meta["u_lattice"]),
        "ref_length": ref_length,
        "alpha_deg": float(meta.get("alpha_deg", 0.0)),
        "re": meta.get("re", meta.get("Re", None)),
    }
    with tempfile.TemporaryDirectory(prefix="golden-lbm-v3-") as tmp:
        staging = Path(tmp)
        guest = LbmV2Dataset.staged_for_case(staging, case_dir)
        raw_x, raw_y = LbmV2Dataset._raw_sample(guest, row)
    sdf_bin = case_dir / "sdf.f32"
    sdf_source = "lbm" if sdf_bin.exists() else "derived_mask"
    model_x, _ = normalize_sample(raw_x, raw_y, norm)
    if not np.all(np.isfinite(model_x)):
        raise SystemExit(f"golden: normalized v3 LBM input for {case_id} is not finite")
    info = {
        "description": (
            f"real LBM pilot case {case_id} (body {meta.get('body')}, "
            f"Re {meta.get('re')}) via the v2 adapter, normalized with the v3 golden norm"
        ),
        "caseId": case_id,
        "refLength": ref_length,
        "refLengthNote": ref_note,
        "sdfSource": sdf_source,
    }
    return model_x[None].astype(np.float32), info


def build_inputs_v3(norm: dict, seed: int, lbm_case: str, ref_override: float | None) -> list[dict]:
    torch.manual_seed(seed)
    rand = torch.randn(1, V3_IN_CH, NY, NX).numpy().astype(np.float32)
    lbm, lbm_info = build_lbm_input_v3(norm, lbm_case, ref_override)
    return [
        {
            "name": "zeros",
            "description": "all zero model input (1, 4, 128, 128)",
            "input": np.zeros((1, V3_IN_CH, NY, NX), np.float32),
        },
        {
            "name": "randn_s7",
            "description": f"standard normal model input, torch manual seed {seed}",
            "input": rand,
        },
        {"name": f"lbm_{lbm_case}", "input": lbm, **lbm_info},
    ]


def run_golden_v3(
    model: torch.nn.Module,
    norm: dict,
    provenance: dict,
    out_dir: Path,
    seed: int = RANDOM_SEED,
    lbm_case: str = GOLDEN_LBM_CASE,
    ref_override: float | None = None,
    tolerance: float = V3_TOLERANCE,
) -> dict:
    """Run the v3 golden set and write fixtures; returns the golden.json dict.

    Torch always runs (spatial plus aux tuple). ONNX runs when this env can
    execute InstanceNormalization, over every case, with separate spatial
    and aux maxima that must each clear the tolerance. Torch spatial plus
    aux outputs persist for all cases; only the zeros case persists ONNX
    spatial plus aux, matching the v2 economy.
    """
    from dataset_v3 import norm_hash_v3

    model.eval()
    cases = build_inputs_v3(norm, seed, lbm_case, ref_override)
    with torch.no_grad():
        torch_pairs = []
        for case in cases:
            spatial, aux = model(torch.from_numpy(case["input"]))
            torch_pairs.append(
                (spatial.numpy().astype(np.float32), aux.numpy().astype(np.float32))
            )

    available, reason = ort_instancenorm_available()
    onnx_pairs: list[tuple[np.ndarray, np.ndarray] | None] = [None] * len(cases)
    max_spatial: float | None = None
    max_aux: float | None = None
    if available:
        import onnxruntime as ort

        with tempfile.TemporaryDirectory(prefix="golden-onnx-v3-") as tmp:
            onnx_path = Path(tmp) / "golden_v3.onnx"
            torch.onnx.export(
                model,
                torch.zeros(1, V3_IN_CH, NY, NX),
                str(onnx_path),
                input_names=["input"],
                output_names=["output", "aux"],
                dynamic_axes=None,
                opset_version=V3_OPSET,
                dynamo=False,
            )
            sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            for i, case in enumerate(cases):
                got_spatial, got_aux = sess.run(
                    ["output", "aux"], {"input": case["input"]}
                )
                got_spatial = np.asarray(got_spatial, dtype=np.float32)
                got_aux = np.asarray(got_aux, dtype=np.float32)
                err_spatial = float(np.max(np.abs(torch_pairs[i][0] - got_spatial)))
                err_aux = float(np.max(np.abs(torch_pairs[i][1] - got_aux)))
                max_spatial = err_spatial if max_spatial is None else max(max_spatial, err_spatial)
                max_aux = err_aux if max_aux is None else max(max_aux, err_aux)
                onnx_pairs[i] = (got_spatial, got_aux)
        for label, value in (("spatial", max_spatial), ("aux", max_aux)):
            if value is None or not np.isfinite(value) or value > tolerance:
                raise SystemExit(f"golden: v3 torch vs onnx max err {label} {value} exceeds {tolerance}")
        print(f"golden: v3 torch vs onnx max_err_spatial={max_spatial:.3e} max_err_aux={max_aux:.3e}")
    else:
        print(f"golden: v3 onnx run skipped: {reason}")

    case_records = []
    onnx_keep = set(GOLDEN_V3_ONNX_CASES)
    for i, case in enumerate(cases):
        case_dir = out_dir / case["name"]
        in_sha = write_f32(case_dir / "input.f32", case["input"])
        spatial_sha = write_f32(case_dir / "expected_torch_spatial.f32", torch_pairs[i][0])
        aux_sha = write_f32(case_dir / "expected_torch_aux.f32", torch_pairs[i][1])
        record: dict = {
            "name": case["name"],
            "description": case["description"],
            "input": {"file": f"{case['name']}/input.f32", "shape": [1, V3_IN_CH, NY, NX], "sha256": in_sha},
            "torchSpatial": {
                "file": f"{case['name']}/expected_torch_spatial.f32",
                "shape": [1, V3_OUT_CH, NY, NX],
                "sha256": spatial_sha,
            },
            "torchAux": {
                "file": f"{case['name']}/expected_torch_aux.f32",
                "shape": [1, V3_AUX_CH],
                "sha256": aux_sha,
            },
            "onnxSpatial": None,
            "onnxAux": None,
        }
        if onnx_pairs[i] is not None and case["name"] in onnx_keep:
            onnx_spatial_sha = write_f32(case_dir / "expected_onnx_spatial.f32", onnx_pairs[i][0])
            onnx_aux_sha = write_f32(case_dir / "expected_onnx_aux.f32", onnx_pairs[i][1])
            record["onnxSpatial"] = {
                "file": f"{case['name']}/expected_onnx_spatial.f32",
                "shape": [1, V3_OUT_CH, NY, NX],
                "sha256": onnx_spatial_sha,
            }
            record["onnxAux"] = {
                "file": f"{case['name']}/expected_onnx_aux.f32",
                "shape": [1, V3_AUX_CH],
                "sha256": onnx_aux_sha,
            }
        if "caseId" in case:
            record["lbmCase"] = case["caseId"]
            record["refLength"] = case["refLength"]
            record["refLengthNote"] = case["refLengthNote"]
            record["sdfSource"] = case["sdfSource"]
        case_records.append(record)

    combined = None
    if max_spatial is not None and max_aux is not None:
        combined = max(max_spatial, max_aux)
    golden = {
        "schema": GOLDEN_SCHEMA_V2,
        "arch": "unet-v3",
        "base": V3_BASE,
        "opset": V3_OPSET,
        "inCh": V3_IN_CH,
        "outCh": V3_OUT_CH,
        "auxCh": V3_AUX_CH,
        "spatialHeads": list(V3_SPATIAL_HEADS),
        "auxHeads": list(V3_AUX_HEADS),
        "tolerance": tolerance,
        "toleranceSpatial": tolerance,
        "toleranceAux": tolerance,
        "seed": seed,
        "normSha256": norm_hash_v3(norm),
        "normSchema": "gearflow-surrogate-norm/v3",
        "layout": "NCHW C-order float32, one sample per file; aux is (1, 3) float32",
        "onnxCases": list(GOLDEN_V3_ONNX_CASES),
        "cases": case_records,
        "torchVsOnnxMaxErrSpatial": max_spatial,
        "torchVsOnnxMaxErrAux": max_aux,
        "torchVsOnnxMaxErr": combined,
        "onnx": {"available": available, "reason": "" if available else reason},
        "provenance": provenance,
        "generatedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "totalBytes": 0,
    }
    golden_path = out_dir / "golden.json"
    for _ in range(4):
        golden_path.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")
        total = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
        if golden["totalBytes"] == total:
            break
        golden["totalBytes"] = total
    else:
        raise SystemExit("golden: totalBytes did not converge")
    print(f"golden: wrote {out_dir} totalBytes={total}")
    budget = GOLDEN_V3_AVAILABLE_BUDGET if available else GOLDEN_V3_SKIP_BUDGET
    if total >= budget:
        raise SystemExit(f"golden: total {total} bytes meets or exceeds the budget {budget}")
    return golden


def main(argv: list[str] | None = None) -> dict:
    parser = argparse.ArgumentParser(description="Generate v2 or v3 ONNX parity goldens")
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--norm", type=Path, default=None)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument(
        "--arch", default=None, choices=["unet-v2", "unet-v3"],
        help="force a contract (default: detect from the checkpoint, synthetic defaults to unet-v2)",
    )
    parser.add_argument("--seed", type=int, default=RANDOM_SEED)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--lbm-case", default=GOLDEN_LBM_CASE)
    parser.add_argument("--ref-length", type=float, default=None)
    args = parser.parse_args(argv)
    want_v3 = args.arch == "unet-v3"
    if args.arch is None and not args.synthetic and args.checkpoint is not None:
        try:
            probe = torch.load(Path(args.checkpoint), map_location="cpu", weights_only=True)
            want_v3 = probe.get("arch", None) == "unet-v3"
        except (OSError, ValueError):
            want_v3 = False
    if want_v3:
        model, norm, provenance = load_bundle_v3(args)
        return run_golden_v3(
            model,
            norm,
            provenance,
            Path(args.out) if args.out is not None else GOLDEN_ROOT_V3,
            seed=args.seed,
            lbm_case=args.lbm_case,
            ref_override=args.ref_length,
        )
    model, norm, provenance = load_bundle(args)
    return run_golden(
        model,
        norm,
        provenance,
        Path(args.out) if args.out is not None else GOLDEN_ROOT,
        seed=args.seed,
        lbm_case=args.lbm_case,
        ref_override=args.ref_length,
    )


if __name__ == "__main__":
    main()
