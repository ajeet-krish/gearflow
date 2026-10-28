"""Deterministic 71 case stability allowlist sweep spec generator.

Local only, stdlib only, no Modal, no network, no randomness. Reads
nothing, writes data/sweep/<sweep_id>/cases.jsonl (CaseSpecV1 JSON lines).
Run by the user before the sweep:

    python training/make_sweep_spec_v2.py SWEEP_ID

An optional out flag (shown in the usage line when run with no
arguments) plus a path writes to that path instead of the default
data sweep location.

Coverage follows local stability probes of the real solver, so the
spec holds only cells the solver can reach. Orifice is gone entirely
(it never completes at any gap or Re) and duct is retired (it only
survives Re 40 and left the app). Layout (71 rows, deterministic
order, no randomness):

  bluff 24 rows on 160 by 128 over width 4.0:
    cylinder r 0.2: Re 20, 40, 60 BGK (u 0.06) plus Re 200, 400,
      600, 700 LES (u 0.08)
    cylinder r 0.15: Re 20, 40, 60 BGK (u 0.06) plus Re 100, 200,
      400 LES (u 0.08)
    block 0.3: Re 20, 40, 60 BGK (u 0.06) plus Re 100, 200,
      400 LES (u 0.08)
    block 0.4: Re 20, 40, 60 BGK (u 0.06) plus Re 100,
      400 LES (u 0.08)
  airfoil 47 rows on 384 by 192 over width 2.55:
    naca0012 and naca2412: alpha -4, 0, 4, 8 at Re 100, 400, 700
      (u 0.08 LES) plus Re 1200 (u 0.12 LES), 32 rows
    naca4412: alpha -4, 0, 4 at Re 100, 400, 700, 1200 plus alpha 8
      at Re 100, 400, 700 (u 0.08 LES below Re 1200, u 0.12 at
      Re 1200), 15 rows

Alpha 12 is excluded everywhere (it diverges at Re 600 and Re 1200).

Excluded bluff cells (measured, not guessed, with the release runner
at transient 8000 and window 12000): cyl_r020_a00_re100_les diverges
at step 4800 (and still diverges at step 6272 with u 0.06), and
block_040_a00_re200_les diverges at step 4470. Re 100 coverage
survives through cyl_r015_a00_re100_les and block_030_a00_re100_les.
cyl_r015_a00_re400_les completes but does not support a phase average
(harmonics invalid with reason no_period, explained 0); it is kept
because an honest invalid row is data.

Transient 16000 for airfoil rows (naca0012_a00_re700_airfoil leaves a
25.7 percent stats versus fit variance gap at transient 8000, falling
to about 2 percent with explained rising from 0.7496 to 0.8024 at
transient 16000), transient 8000 for bluff rows, window 12000
everywhere, substitutes_for null throughout.
Case ids read as <body>_<tag>_a<alpha>_re<re>_<branch>, for example
cyl_r020_a00_re020_resolved, block_040_a00_re400_les, and
naca4412_am04_re1200_airfoil. Negative alpha uses m in place of the
sign, so alpha -4 becomes am04. Bluff BGK rows carry the resolved
tag, bluff LES rows carry the les tag, airfoil rows carry the
airfoil tag.

Body naming note: the 4412 family is stored with body naca4 and
naca_code 4412 because the shared CaseSpecV1 validator only accepts
naca0012, naca2412, and naca4 bodies. Case ids still carry the
naca4412 prefix so the family stays readable.

Tau gate: tau mirrors the solver exactly. The solver derives d_phys
from body_height_phys, not from ref_length: 2 r for cylinders,
h abs(cos alpha) + w abs(sin alpha) for blocks, and the projected y
extent of the rotated NACA surface polygon for airfoils (standard 4
digit camber plus thickness surface sampled at 60 beta spaced
points, rotated by angle -alpha about the origin). Calibration
against the solver: naca0012 alpha 0 gives 18.02 cells and naca2412
alpha 8 gives 27.62 cells at dx = 2.55 / 383, reproduced by
naca_d_lat_cells within 0.01 cells. With dx = domain_width /
(nx - 1), d_lat = d_phys / dx, nu = u_lattice d_lat / re, and
tau = 0.5 + 3 nu. Every row must sit strictly above TAU_FLOOR
(0.505). build_cases returns the rows, check_tau_floor raises
ValueError naming every offending case id and tau, and write_cases
refuses to write while any row breaches the floor.
"""

import json
import math
import sys
from pathlib import Path
from typing import Optional

try:
    from make_sweep_spec import validate_case as _validate_case_v1
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from make_sweep_spec import validate_case as _validate_case_v1

TRANSIENT = 8000
TRANSIENT_AIRFOIL = 16000
WINDOW = 12000
U_BGK = 0.06
U_LES = 0.08
U_HI = 0.12
TAU_FLOOR = 0.505

BLUFF_NX = 160
BLUFF_NY = 128
AIR_NX = 384
AIR_NY = 192
BLUFF_WIDTH = 4.0
AIRFOIL_WIDTH = 2.55
CHORD = 1.0
NACA_SAMPLES = 60

BGK_TAG = "resolved"
LES_TAG = "les"
AIRFOIL_TAG = "airfoil"

OUT_FLAG = chr(45) + chr(45) + "out"

BGK_RES = (20.0, 40.0, 60.0)
BLUFF_LES_RES = (100.0, 200.0, 400.0)
CYL_R020_EXTRA_RES = (600.0, 700.0)
AIR_LO_RES = (100.0, 400.0, 700.0)
AIR_HI_RE = 1200.0
AIR_MAIN_ALPHAS = (-4.0, 0.0, 4.0, 8.0)

AIRFOIL_FAMILIES = (
    ("naca0012", "naca0012", "0012"),
    ("naca2412", "naca2412", "2412"),
    ("naca4412", "naca4", "4412"),
)


def _slug_int(value: float, digits: int) -> str:
    return str(int(round(value))).zfill(digits)


def _alpha_tag(alpha: float) -> str:
    if alpha < 0.0:
        return "m" + str(int(round(-alpha))).zfill(2)
    return str(int(round(alpha))).zfill(2)


def _naca_params(code: str) -> tuple:
    digits = [int(ch) for ch in code]
    m = digits[0] / 100.0
    if m == 0.0:
        p = 0.0
    else:
        p = digits[1] / 10.0
    t = (digits[2] * 10 + digits[3]) / 100.0
    return (m, p, t)


def naca_projected_height(naca_code: str, alpha_deg: float) -> float:
    """Projected y extent of the rotated NACA surface polygon.

    Mirrors naca4_airfoil plus transform_points in
    rust/gearflow-wasm/src/geometry.rs: 60 beta spaced chord stations,
    closed trailing edge coefficient -0.1036, camber line plus normal
    thickness offset, rotation by angle -alpha about the origin with
    chord 1. Translation never changes the extent, so the solver center
    is irrelevant here.
    """
    m, p, t = _naca_params(naca_code)
    n = NACA_SAMPLES
    xs = []
    for i in range(n):
        beta = (float(i) / float(n - 1)) * math.pi
        xs.append((1.0 - math.cos(beta)) / 2.0)
    upper = []
    lower = []
    for x in xs:
        yt = (
            5.0
            * t
            * (
                0.2969 * math.sqrt(x)
                - 0.126 * x
                - 0.3516 * x * x
                + 0.2843 * x * x * x
                - 0.1036 * x * x * x * x
            )
        )
        yc = 0.0
        dyc = 0.0
        if m > 1e-10 and p > 1e-10:
            if x < p:
                yc = (m / (p * p)) * (2.0 * p * x - x * x)
                dyc = ((2.0 * m) / (p * p)) * (p - x)
            else:
                yc = (m / ((1.0 - p) * (1.0 - p))) * (
                    1.0 - 2.0 * p + 2.0 * p * x - x * x
                )
                dyc = ((2.0 * m) / ((1.0 - p) * (1.0 - p))) * (p - x)
        theta = math.atan(dyc)
        sin_t = math.sin(theta)
        cos_t = math.cos(theta)
        upper.append((x - yt * sin_t, yc + yt * cos_t))
        lower.append((x + yt * sin_t, yc - yt * cos_t))
    angle = -float(alpha_deg) * math.pi / 180.0
    sin_a = math.sin(angle)
    cos_a = math.cos(angle)
    lo = math.inf
    hi = -math.inf
    for x, y in upper + lower:
        yp = x * sin_a + y * cos_a
        if yp < lo:
            lo = yp
        if yp > hi:
            hi = yp
    return hi - lo


def naca_d_lat_cells(
    naca_code: str,
    alpha_deg: float,
    nx: int = AIR_NX,
    domain_width: float = AIRFOIL_WIDTH,
) -> float:
    """Airfoil body height in lattice cells at the spec grid."""
    dx = float(domain_width) / (int(nx) - 1)
    return naca_projected_height(naca_code, alpha_deg) / dx


def body_d_phys(row: dict) -> float:
    """Solver body height in physical units for one spec row."""
    body = str(row["body"])
    if body == "cylinder":
        return 2.0 * float(row["radius"])
    if body == "block":
        angle = math.radians(float(row["alpha_deg"]))
        return float(row["height"]) * abs(math.cos(angle)) + float(
            row["width"]
        ) * abs(math.sin(angle))
    code = row.get("naca_code")
    if code is None and body.startswith("naca") and len(body) == 8:
        code = body[4:]
    return naca_projected_height(str(code), float(row["alpha_deg"]))


def _make_row(
    case_id: str,
    body: str,
    re: float,
    u_lattice: float,
    alpha_deg: float,
    les: bool,
    nx: int,
    ny: int,
    domain_width: float,
    radius: Optional[float],
    width: Optional[float],
    height: Optional[float],
    naca_code: Optional[str],
    ref_length: float,
    note: str,
    transient: int = TRANSIENT,
) -> dict:
    return {
        "case_id": case_id,
        "body": body,
        "re": float(re),
        "u_lattice": float(u_lattice),
        "alpha_deg": float(alpha_deg),
        "les": bool(les),
        "nx": int(nx),
        "ny": int(ny),
        "domain_width": float(domain_width),
        "radius": None if radius is None else float(radius),
        "width": None if width is None else float(width),
        "height": None if height is None else float(height),
        "naca_code": naca_code,
        "ref_length": float(ref_length),
        "transient": int(transient),
        "window": int(WINDOW),
        "substitutes_for": None,
        "note": str(note),
    }


def _bluff_re_u_les(re: float) -> tuple:
    if re in BGK_RES:
        return (U_BGK, False, BGK_TAG)
    return (U_LES, True, LES_TAG)


def build_cases() -> list:
    rows: list = []
    for radius in (0.15, 0.2):
        tag = "015" if radius < 0.16 else "020"
        levels = list(BGK_RES) + list(BLUFF_LES_RES)
        if radius > 0.16:
            levels = levels + list(CYL_R020_EXTRA_RES)
        for re in levels:
            if radius > 0.16 and abs(float(re) - 100.0) < 1e-12:
                continue
            u, les, branch = _bluff_re_u_les(re)
            case_id = (
                "cyl_r"
                + tag
                + "_a00_re"
                + _slug_int(re, 3)
                + "_"
                + branch
            )
            note = "cylinder radius " + str(radius) + " Re " + _slug_int(re, 3)
            note += " BGK baseline" if not les else " LES stability allowlist"
            rows.append(
                _make_row(
                    case_id, "cylinder", re, u, 0.0, les,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    radius, None, None, None, 2.0 * radius, note,
                )
            )
    for size in (0.3, 0.4):
        tag = "030" if size < 0.35 else "040"
        for re in list(BGK_RES) + list(BLUFF_LES_RES):
            if size > 0.35 and abs(float(re) - 200.0) < 1e-12:
                continue
            u, les, branch = _bluff_re_u_les(re)
            case_id = (
                "block_"
                + tag
                + "_a00_re"
                + _slug_int(re, 3)
                + "_"
                + branch
            )
            note = "block " + str(size) + " by " + str(size)
            note += " Re " + _slug_int(re, 3)
            note += " BGK baseline" if not les else " LES stability allowlist"
            rows.append(
                _make_row(
                    case_id, "block", re, u, 0.0, les,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    None, size, size, None, size, note,
                )
            )
    for prefix, body, code in AIRFOIL_FAMILIES:
        alphas = list(AIR_MAIN_ALPHAS)
        for alpha in alphas:
            a_tag = _alpha_tag(alpha)
            levels = list(AIR_LO_RES) + [AIR_HI_RE]
            if body == "naca4" and alpha == 8.0:
                levels = list(AIR_LO_RES)
            for re in levels:
                u = U_HI if re > 700.0 else U_LES
                case_id = (
                    prefix + "_a" + a_tag + "_re" + _slug_int(re, 3)
                    + "_" + AIRFOIL_TAG
                )
                note = prefix + " alpha " + a_tag + " Re " + _slug_int(re, 3)
                note += " airfoil allowlist LES"
                rows.append(
                    _make_row(
                        case_id, body, re, u, alpha, True,
                        AIR_NX, AIR_NY, AIRFOIL_WIDTH,
                        None, None, None, code, CHORD, note,
                        TRANSIENT_AIRFOIL,
                    )
                )
    return rows


def compute_tau(row: dict) -> float:
    dx = float(row["domain_width"]) / (int(row["nx"]) - 1)
    d_lat = body_d_phys(row) / dx
    nu = float(row["u_lattice"]) * d_lat / float(row["re"])
    return 0.5 + 3.0 * nu


def min_tau_row(rows: list) -> tuple:
    worst_id = ""
    worst_tau = math.inf
    for row in rows:
        tau = compute_tau(row)
        if tau < worst_tau:
            worst_tau = tau
            worst_id = str(row.get("case_id"))
    return (worst_id, worst_tau)


def check_tau_floor(rows: list, floor: float = TAU_FLOOR) -> tuple:
    worst_id, worst_tau = min_tau_row(rows)
    breaches: list = []
    for row in rows:
        tau = compute_tau(row)
        if not tau > floor:
            breaches.append(str(row.get("case_id")) + " tau " + ("%.6f" % tau))
    if breaches:
        raise ValueError(
            "tau floor breach: " + "; ".join(breaches)
            + " floor " + str(floor)
            + " breaching rows " + str(len(breaches))
            + " min " + worst_id + " " + ("%.6f" % worst_tau)
        )
    return (worst_id, worst_tau)


def _branch_of(row: dict) -> Optional[str]:
    case_id = str(row.get("case_id", ""))
    for branch in (BGK_TAG, LES_TAG, AIRFOIL_TAG):
        if case_id.endswith("_" + branch):
            return branch
    return None


def validate_v2_row(row: dict) -> Optional[str]:
    problem = _validate_case_v1(row)
    if problem is not None:
        return problem
    case_id = str(row["case_id"])
    body = str(row["body"])
    branch = _branch_of(row)
    if branch is None:
        return "case_id " + case_id + ": missing branch suffix, want _" + BGK_TAG + ", _" + LES_TAG + ", or _" + AIRFOIL_TAG
    airfoil = body in ("naca0012", "naca2412", "naca4")
    if airfoil:
        if branch != AIRFOIL_TAG:
            return "case_id " + case_id + ": suffix _" + branch + " mismatches airfoil body " + body
        if (int(row["nx"]), int(row["ny"])) != (AIR_NX, AIR_NY):
            return "case_id " + case_id + ": airfoil grid must be 384 by 192"
        if abs(float(row["domain_width"]) - AIRFOIL_WIDTH) > 1e-12:
            return "case_id " + case_id + ": airfoil width must be 2.55"
    else:
        if branch not in (BGK_TAG, LES_TAG):
            return "case_id " + case_id + ": suffix _" + branch + " mismatches bluff body " + body
        if (int(row["nx"]), int(row["ny"])) != (BLUFF_NX, BLUFF_NY):
            return "case_id " + case_id + ": bluff grid must be 160 by 128"
        if abs(float(row["domain_width"]) - BLUFF_WIDTH) > 1e-12:
            return "case_id " + case_id + ": bluff width must be 4.0"
    les = row["les"]
    u = float(row["u_lattice"])
    re = float(row["re"])
    if les is True:
        if re < 100.0:
            return "case_id " + case_id + ": LES branch needs Re 100 or above"
        if re > 700.0:
            if abs(u - U_HI) > 1e-12:
                return "case_id " + case_id + ": high Re LES branch needs u 0.12 above Re 700"
        elif abs(u - U_LES) > 1e-12:
            return "case_id " + case_id + ": LES branch needs u 0.08 up to Re 700"
    else:
        if not 20.0 <= re <= 100.0:
            return "case_id " + case_id + ": BGK branch needs Re 20 to 100"
        if abs(u - U_BGK) > 1e-12:
            return "case_id " + case_id + ": BGK branch needs u 0.06"
    code = row.get("naca_code")
    if airfoil:
        if code is None:
            return "case_id " + case_id + ": airfoil rows need naca_code"
        if (body, code) not in {
            ("naca0012", "0012"), ("naca2412", "2412"), ("naca4", "4412"),
        }:
            return "case_id " + case_id + ": naca_code " + str(code) + " mismatches body " + body
    elif code is not None:
        return "case_id " + case_id + ": naca_code must be null outside airfoils"
    return None


def validate_all_v2(rows: list) -> list:
    errors: list = []
    seen: set = set()
    for row in rows:
        case_id = str(row.get("case_id"))
        if case_id in seen:
            errors.append("duplicate case_id " + case_id)
            continue
        seen.add(case_id)
        problem = validate_v2_row(row)
        if problem is not None:
            errors.append(problem)
    return errors


def _sweep_id_error(sweep_id: object) -> Optional[str]:
    if not isinstance(sweep_id, str) or not sweep_id:
        return "sweep_id must be a non empty string"
    if sweep_id in (".", "..") or "/" in sweep_id or "\\" in sweep_id:
        return "sweep_id must be a plain directory name"
    return None


def spec_path_for(sweep_id: str, repo_root: Optional[Path] = None) -> Path:
    root = repo_root if repo_root is not None else Path(__file__).resolve().parent.parent
    return root / "data" / "sweep" / sweep_id / "cases.jsonl"


def write_cases(sweep_id: str, out_path: Optional[Path] = None) -> Path:
    error = _sweep_id_error(sweep_id)
    if error is not None:
        raise ValueError(error)
    rows = build_cases()
    problems = validate_all_v2(rows)
    if problems:
        raise ValueError("spec validation failed: " + problems[0])
    check_tau_floor(rows)
    target = out_path if out_path is not None else spec_path_for(sweep_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return target


def main(argv: Optional[list] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    sweep_id = ""
    out_path: Optional[Path] = None
    if len(args) == 1:
        sweep_id = args[0]
    elif len(args) == 3 and args[1] == OUT_FLAG:
        sweep_id = args[0]
        out_path = Path(args[2])
    else:
        print(
            "usage: make_sweep_spec_v2.py SWEEP_ID [" + OUT_FLAG + " PATH]",
            file=sys.stderr,
        )
        return 2
    try:
        target = write_cases(sweep_id, out_path)
    except ValueError as exc:
        print("make_sweep_spec_v2: " + str(exc), file=sys.stderr)
        return 2
    rows = build_cases()
    n_bgk = sum(1 for r in rows if str(r["case_id"]).endswith("_" + BGK_TAG))
    n_les = sum(1 for r in rows if str(r["case_id"]).endswith("_" + LES_TAG))
    n_air = len(rows) - n_bgk - n_les
    worst_id, worst_tau = min_tau_row(rows)
    print(
        "make_sweep_spec_v2: wrote " + str(len(rows))
        + " cases (BGK " + str(n_bgk) + ", LES " + str(n_les)
        + ", airfoil " + str(n_air) + ")"
        + " to " + str(target)
        + "; min tau " + ("%.6f" % worst_tau) + " at " + worst_id
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
