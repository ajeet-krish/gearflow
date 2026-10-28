"""Deterministic 60 case sweep spec generator for the Modal CPU sweep.

Local only, stdlib only, no Modal, no network, no randomness. Reads
nothing, writes data/sweep/<sweep_id>/cases.jsonl (CaseSpecV1 JSON lines).
Run by the user before the sweep:

    python training/make_sweep_spec.py <sweep_id>

Design decision (recorded here and pinned by tests): Re 100 bluff body
BGK rows are excluded from the default 60. The pilot table in
docs/ARCHITECTURE-LBM-PHASE10.md section 11 shows the two Re 100 bluff
BGK points (cylinder r 0.2, block 0.4) diverging on the short 10 diameter
tunnel at about 12.5 percent blockage while the same tau survives in the
longer reference tunnel, so fetch and blockage decide the margin here.
High Re bluff coverage comes from the LES branch instead: 6 cylinder LES
rows (2 radii at Re 100, 200, 400) plus 6 block LES rows (2 sizes at Re
100, 200, 400), 12 rows total. The 4 excluded rows are the cylinder Re
100 BGK pair and the block Re 100 BGK pair. Airfoil rows are all LES.
Duct rows stay BGK at low Re. Orifice uses BGK at Re 100, LES at Re 200.

Layout (60 rows, deterministic order, no randomness):
  cylinders 12: radius 0.15, 0.2 at Re 20, 40, 60 BGK plus Re 100, 200, 400 LES
  blocks 10: size 0.3, 0.4 at Re 40, 60 BGK plus Re 100, 200, 400 LES
  airfoils 30: NACA0012, 2412 at alpha 0, 2, 4, 6, 8 at Re 100, 200, 400 LES
  duct 6: gap 0.3, 0.4, 0.5 at Re 40, 100 BGK
  orifice 2: gap 0.4 at Re 100 BGK plus Re 200 LES
Grids follow the pilot: bluff, duct, orifice use 160 by 128 over
width 4.0; airfoils use 256 by 128 over width 2.55. BGK rows use
u_lattice 0.06, LES rows use 0.08. Transient 8000, window 12000,
substitutes_for null throughout. Validation mirrors the runner spec
parser in rust dataset_pilot (required keys, ranges, grid caps).
"""

import json
import math
import sys
from pathlib import Path
from typing import Optional

TRANSIENT = 8000
WINDOW = 12000
U_BGK = 0.06
U_LES = 0.08
BLUFF_NX = 160
BLUFF_NY = 128
BLUFF_WIDTH = 4.0
AIRFOIL_NX = 256
AIRFOIL_NY = 128
AIRFOIL_WIDTH = 2.55
ORIFICE_WIDTH = 0.1

ALLOWED_BODIES = {
    "cylinder",
    "block",
    "naca0012",
    "naca2412",
    "naca4",
    "duct",
    "orifice",
}

SPEC_KEYS = [
    "case_id",
    "body",
    "re",
    "u_lattice",
    "alpha_deg",
    "les",
    "nx",
    "ny",
    "domain_width",
    "radius",
    "width",
    "height",
    "naca_code",
    "ref_length",
    "transient",
    "window",
    "substitutes_for",
    "note",
]


def _slug_int(value: float, digits: int) -> str:
    return str(int(round(value))).zfill(digits)


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
        "transient": int(TRANSIENT),
        "window": int(WINDOW),
        "substitutes_for": None,
        "note": str(note),
    }


def build_cases() -> list[dict]:
    rows: list[dict] = []
    for radius in (0.15, 0.2):
        tag = "015" if radius < 0.16 else "020"
        for re in (20.0, 40.0, 60.0):
            case_id = "cyl_r" + tag + "_re" + _slug_int(re, 3)
            note = "cylinder radius " + str(radius) + " Re " + _slug_int(re, 3)
            note += " BGK short tunnel baseline"
            rows.append(
                _make_row(
                    case_id, "cylinder", re, U_BGK, 0.0, False,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    radius, None, None, None, 2.0 * radius, note,
                )
            )
        for re in (100.0, 200.0, 400.0):
            case_id = "cyl_r" + tag + "_re" + _slug_int(re, 3)
            note = "cylinder radius " + str(radius) + " Re " + _slug_int(re, 3)
            note += " LES high Re branch, stable on short tunnel"
            rows.append(
                _make_row(
                    case_id, "cylinder", re, U_LES, 0.0, True,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    radius, None, None, None, 2.0 * radius, note,
                )
            )
    for size in (0.3, 0.4):
        tag = "030" if size < 0.35 else "040"
        for re in (40.0, 60.0):
            case_id = "block_" + tag + "_re" + _slug_int(re, 3)
            note = "block " + str(size) + " by " + str(size) + " Re " + _slug_int(re, 3)
            note += " BGK short tunnel baseline"
            rows.append(
                _make_row(
                    case_id, "block", re, U_BGK, 0.0, False,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    None, size, size, None, size, note,
                )
            )
        for re in (100.0, 200.0, 400.0):
            case_id = "block_" + tag + "_re" + _slug_int(re, 3)
            note = "block " + str(size) + " by " + str(size) + " Re " + _slug_int(re, 3)
            note += " LES high Re branch, stable on short tunnel"
            rows.append(
                _make_row(
                    case_id, "block", re, U_LES, 0.0, True,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    None, size, size, None, size, note,
                )
            )
    for body, code in (("naca0012", "0012"), ("naca2412", "2412")):
        for alpha in (0.0, 2.0, 4.0, 6.0, 8.0):
            a_tag = _slug_int(alpha, 2)
            for re in (100.0, 200.0, 400.0):
                case_id = body + "_a" + a_tag + "_re" + _slug_int(re, 3)
                note = body + " alpha " + a_tag + " Re " + _slug_int(re, 3)
                note += " LES thin body low tau stabilised"
                rows.append(
                    _make_row(
                        case_id, body, re, U_LES, alpha, True,
                        AIRFOIL_NX, AIRFOIL_NY, AIRFOIL_WIDTH,
                        None, None, None, code, 1.0, note,
                    )
                )
    for gap in (0.3, 0.4, 0.5):
        tag = _slug_int(gap * 100.0, 3)
        for re in (40.0, 100.0):
            case_id = "duct_h" + tag + "_re" + _slug_int(re, 3)
            note = "duct gap " + str(gap) + " Re " + _slug_int(re, 3)
            note += " BGK parabolic inlet"
            rows.append(
                _make_row(
                    case_id, "duct", re, U_BGK, 0.0, False,
                    BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                    None, None, gap, None, gap, note,
                )
            )
    for re, les, u in ((100.0, False, U_BGK), (200.0, True, U_LES)):
        case_id = "orifice_h040_re" + _slug_int(re, 3)
        branch = "LES high Re branch" if les else "BGK constriction"
        note = "orifice gap 0.4 Re " + _slug_int(re, 3) + " " + branch
        rows.append(
            _make_row(
                case_id, "orifice", re, u, 0.0, les,
                BLUFF_NX, BLUFF_NY, BLUFF_WIDTH,
                None, ORIFICE_WIDTH, 0.4, None, 0.4, note,
            )
        )
    return rows


def _is_num(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_case(row: dict) -> Optional[str]:
    for key in SPEC_KEYS:
        if key not in row:
            return "missing key " + key + " in " + str(row.get("case_id"))
    case_id = row.get("case_id")
    body = row.get("body")
    if not isinstance(case_id, str) or not case_id:
        return "case_id must be a non empty string"
    if not isinstance(body, str) or not body:
        return "case_id " + str(case_id) + ": body must be a non empty string"
    if body not in ALLOWED_BODIES:
        return "case_id " + case_id + ": unknown body " + str(body)
    re = row.get("re")
    if not _is_num(re) or not math.isfinite(float(re)) or float(re) <= 0.0:
        return "case_id " + case_id + ": re must be positive finite"
    u = row.get("u_lattice")
    if not _is_num(u) or not (0.02 <= float(u) <= 0.12):
        return "case_id " + case_id + ": u_lattice outside [0.02, 0.12]"
    alpha = row.get("alpha_deg")
    if not _is_num(alpha) or not math.isfinite(float(alpha)):
        return "case_id " + case_id + ": alpha_deg must be finite"
    if not isinstance(row.get("les"), bool):
        return "case_id " + case_id + ": les must be boolean"
    nx = row.get("nx")
    ny = row.get("ny")
    if not isinstance(nx, int) or not isinstance(ny, int):
        return "case_id " + case_id + ": nx and ny must be integers"
    if nx < 4 or ny < 4 or nx > 512 or ny > 512 or nx * ny > 262144:
        return "case_id " + case_id + ": bad grid " + str(nx) + "x" + str(ny)
    width = row.get("domain_width")
    if not _is_num(width) or not math.isfinite(float(width)) or float(width) <= 0.0:
        return "case_id " + case_id + ": domain_width must be positive finite"
    ref = row.get("ref_length")
    if not _is_num(ref) or not math.isfinite(float(ref)) or float(ref) <= 0.0:
        return "case_id " + case_id + ": ref_length must be positive finite"
    for key in ("transient", "window"):
        val = row.get(key)
        if not isinstance(val, int) or val < 0:
            return "case_id " + case_id + ": " + key + " must be a non negative integer"
    note = row.get("note")
    if not isinstance(note, str) or not note:
        return "case_id " + case_id + ": note must be a non empty string"
    for key in ("radius", "width", "height"):
        val = row.get(key)
        if val is not None:
            if not _is_num(val) or not math.isfinite(float(val)) or float(val) <= 0.0:
                return "case_id " + case_id + ": " + key + " must be a number or null"
    code = row.get("naca_code")
    if code is not None:
        if not isinstance(code, str) or len(code) != 4 or not code.isdigit():
            return "case_id " + case_id + ": naca_code must be 4 digits or null"
    if body in ("naca0012", "naca2412"):
        suffix = body[4:]
        if code is not None and code != suffix:
            return "case_id " + case_id + ": naca_code must match body suffix or null"
    if body == "naca4" and code is None:
        return "case_id " + case_id + ": naca4 body needs naca_code"
    sub = row.get("substitutes_for")
    if sub is not None:
        if not isinstance(sub, str) or not sub:
            return "case_id " + case_id + ": substitutes_for must be a string or null"
    return None


def validate_all(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for row in rows:
        case_id = str(row.get("case_id"))
        if case_id in seen:
            errors.append("duplicate case_id " + case_id)
            continue
        seen.add(case_id)
        problem = validate_case(row)
        if problem is not None:
            errors.append(problem)
    return errors


def spec_path_for(sweep_id: str, repo_root: Optional[Path] = None) -> Path:
    root = repo_root if repo_root is not None else Path(__file__).resolve().parent.parent
    return root / "data" / "sweep" / sweep_id / "cases.jsonl"


def write_cases(sweep_id: str, out_path: Optional[Path] = None) -> Path:
    if not isinstance(sweep_id, str) or not sweep_id:
        raise ValueError("sweep_id must be a non empty string")
    if sweep_id in (".", "..") or "/" in sweep_id or "\\" in sweep_id:
        raise ValueError("sweep_id must be a plain directory name")
    rows = build_cases()
    errors = validate_all(rows)
    if errors:
        raise ValueError("spec validation failed: " + errors[0])
    target = out_path if out_path is not None else spec_path_for(sweep_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return target


def main(argv: Optional[list[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: make_sweep_spec.py SWEEP_ID", file=sys.stderr)
        return 2
    try:
        target = write_cases(args[0])
    except ValueError as exc:
        print("make_sweep_spec: " + str(exc), file=sys.stderr)
        return 2
    print("make_sweep_spec: wrote 60 cases to " + str(target))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
