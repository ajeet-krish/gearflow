"""Tests for training/make_sweep_spec_v2.py, the 71 case allowlist sweep.

No Modal, no network, no randomness, no data writes outside tmp_path.
Pins the 71 row count, unique readable ids, bluff and airfoil counts,
the exact airfoil alpha by Re allowlist per family, alpha 12 absent,
orifice and duct absent, the two measured unstable bluff cells absent,
per family transient (8000 bluff, 16000 airfoil), determinism,
CaseSpecV1 validity plus grid and branch rules, the solver mirrored
tau gate with its two geometry calibration points, and sweep id
sanitation.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_sweep_spec import validate_case as validate_case_v1
from make_sweep_spec_v2 import (
    AIRFOIL_TAG,
    BGK_TAG,
    LES_TAG,
    OUT_FLAG,
    TAU_FLOOR,
    TRANSIENT_AIRFOIL,
    build_cases,
    check_tau_floor,
    compute_tau,
    main,
    min_tau_row,
    naca_d_lat_cells,
    validate_all_v2,
    validate_v2_row,
    write_cases,
)

CYL_R020_RES = (20.0, 40.0, 60.0, 200.0, 400.0, 600.0, 700.0)
CYL_R015_RES = (20.0, 40.0, 60.0, 100.0, 200.0, 400.0)
BLOCK_030_RES = (20.0, 40.0, 60.0, 100.0, 200.0, 400.0)
BLOCK_040_RES = (20.0, 40.0, 60.0, 100.0, 400.0)
AIR_MAIN_RES = (100.0, 400.0, 700.0, 1200.0)
AIR_4412_A08_RES = (100.0, 400.0, 700.0)
MAIN_ALPHAS = (-4.0, 0.0, 4.0, 8.0)


def _by_id(rows: list) -> dict:
    return {str(row["case_id"]): row for row in rows}


def _airfoil_key_set(rows: list, code: str) -> set:
    return {
        (float(row["alpha_deg"]), float(row["re"]))
        for row in rows
        if row.get("naca_code") == code
    }


def test_row_count_is_71() -> None:
    assert len(build_cases()) == 71


def test_ids_unique_and_deterministic() -> None:
    first = build_cases()
    second = build_cases()
    assert [r["case_id"] for r in first] == [r["case_id"] for r in second]
    assert [json.dumps(r, sort_keys=True) for r in first] == [
        json.dumps(r, sort_keys=True) for r in second
    ]
    ids = [str(r["case_id"]) for r in first]
    assert len(set(ids)) == 71


def test_removed_unstable_cells_absent() -> None:
    by_id = _by_id(build_cases())
    assert "cyl_r020_a00_re100_les" not in by_id
    assert "block_040_a00_re200_les" not in by_id


def test_case_ids_readable_format() -> None:
    prefixes = ("cyl_", "block_", "naca0012_", "naca2412_", "naca4412_")
    for row in build_cases():
        case_id = str(row["case_id"])
        assert case_id.startswith(prefixes)
        assert "_a" in case_id and "_re" in case_id
        assert case_id.endswith(
            ("_" + BGK_TAG, "_" + LES_TAG, "_" + AIRFOIL_TAG)
        )
    by_id = _by_id(build_cases())
    assert "cyl_r020_a00_re020_resolved" in by_id
    assert "block_040_a00_re400_les" in by_id
    assert "naca0012_a00_re1200_airfoil" in by_id
    assert "naca4412_am04_re1200_airfoil" in by_id


def test_body_and_family_counts() -> None:
    rows = build_cases()
    bodies: dict = {}
    for row in rows:
        bodies[str(row["body"])] = bodies.get(str(row["body"]), 0) + 1
    assert bodies == {
        "cylinder": 13, "block": 11,
        "naca0012": 16, "naca2412": 16, "naca4": 15,
    }
    codes: dict = {}
    for row in rows:
        if row["naca_code"] is not None:
            codes[str(row["naca_code"])] = codes.get(str(row["naca_code"]), 0) + 1
    assert codes == {"0012": 16, "2412": 16, "4412": 15}


def test_bluff_allowlist_combos() -> None:
    rows = build_cases()

    def res_for(body: str, key: str, val: float) -> set:
        return {
            float(r["re"]) for r in rows
            if str(r["body"]) == body and float(r[key]) == val
        }

    assert res_for("cylinder", "radius", 0.2) == set(CYL_R020_RES)
    assert res_for("cylinder", "radius", 0.15) == set(CYL_R015_RES)
    assert res_for("block", "width", 0.4) == set(BLOCK_040_RES)
    assert res_for("block", "width", 0.3) == set(BLOCK_030_RES)


def test_airfoil_alpha_re_combinations_present() -> None:
    rows = [r for r in build_cases() if r["naca_code"] is not None]
    assert len(rows) == 47
    main_grid = {(a, re) for a in MAIN_ALPHAS for re in AIR_MAIN_RES}
    assert _airfoil_key_set(rows, "0012") == main_grid
    assert _airfoil_key_set(rows, "2412") == main_grid
    assert _airfoil_key_set(rows, "4412") == (
        {(a, re) for a in (-4.0, 0.0, 4.0) for re in AIR_MAIN_RES}
        | {(8.0, re) for re in AIR_4412_A08_RES}
    )


def test_alpha_12_absent() -> None:
    for row in build_cases():
        assert float(row["alpha_deg"]) != 12.0
        assert "a12" not in str(row["case_id"])


def test_orifice_and_duct_absent() -> None:
    for row in build_cases():
        assert str(row["body"]) not in ("orifice", "duct")
        assert not str(row["case_id"]).startswith(("orifice_", "duct_"))


def test_all_rows_validate_clean() -> None:
    rows = build_cases()
    assert validate_all_v2(rows) == []
    for row in rows:
        assert validate_case_v1(row) is None
        assert validate_v2_row(row) is None


def test_naca_body_code_mapping() -> None:
    for row in build_cases():
        code = row["naca_code"]
        body = str(row["body"])
        if code is None:
            assert body in ("cylinder", "block")
        else:
            assert (body, code) in {
                ("naca0012", "0012"), ("naca2412", "2412"), ("naca4", "4412"),
            }


def test_grids_windows_u_les_and_ref() -> None:
    for row in build_cases():
        case_id = str(row["case_id"])
        assert int(row["window"]) == 12000
        assert row["substitutes_for"] is None
        body = str(row["body"])
        airfoil = body in ("naca0012", "naca2412", "naca4")
        if airfoil:
            assert int(row["transient"]) == TRANSIENT_AIRFOIL == 16000
            assert case_id.endswith("_" + AIRFOIL_TAG)
            assert (int(row["nx"]), int(row["ny"])) == (384, 192)
            assert abs(float(row["domain_width"]) - 2.55) < 1e-12
            assert row["les"] is True
            if abs(float(row["re"]) - 1200.0) < 1e-12:
                assert abs(float(row["u_lattice"]) - 0.12) < 1e-12
            else:
                assert abs(float(row["re"]) - 1200.0) > 1e-12
                assert abs(float(row["u_lattice"]) - 0.08) < 1e-12
            assert abs(float(row["ref_length"]) - 1.0) < 1e-12
        else:
            assert int(row["transient"]) == 8000
            assert (int(row["nx"]), int(row["ny"])) == (160, 128)
            assert abs(float(row["domain_width"]) - 4.0) < 1e-12
            if row["les"] is True:
                assert case_id.endswith("_" + LES_TAG)
                assert float(row["re"]) >= 100.0
                assert abs(float(row["u_lattice"]) - 0.08) < 1e-12
            else:
                assert case_id.endswith("_" + BGK_TAG)
                assert 20.0 <= float(row["re"]) <= 100.0
                assert abs(float(row["u_lattice"]) - 0.06) < 1e-12
            if body == "cylinder":
                assert abs(float(row["ref_length"]) - 2.0 * float(row["radius"])) < 1e-12
            else:
                assert abs(float(row["ref_length"]) - float(row["width"])) < 1e-12
                assert abs(float(row["ref_length"]) - float(row["height"])) < 1e-12


def test_geometry_calibration_matches_solver() -> None:
    assert naca_d_lat_cells("0012", 0.0) == pytest.approx(18.02, abs=0.01)
    assert naca_d_lat_cells("2412", 8.0) == pytest.approx(27.62, abs=0.01)


def test_all_cases_above_tau_floor() -> None:
    rows = build_cases()
    bad = [
        (str(r["case_id"]), compute_tau(r))
        for r in rows
        if not compute_tau(r) > TAU_FLOOR
    ]
    assert bad == [], "rows at or below floor: " + str(bad)
    worst_id, worst_tau = min_tau_row(rows)
    assert worst_tau > TAU_FLOOR
    assert worst_id == "naca0012_a00_re1200_airfoil"


def test_tau_gate_rejects_bad_row() -> None:
    rows = build_cases()
    bad_row = dict(_by_id(rows)["naca0012_a00_re1200_airfoil"])
    bad_row["re"] = 100000.0
    with pytest.raises(ValueError, match="tau floor breach"):
        check_tau_floor([bad_row])
    try:
        check_tau_floor([bad_row])
        raise AssertionError("check_tau_floor must raise on the bad row")
    except ValueError as exc:
        assert "naca0012_a00_re1200_airfoil" in str(exc)
        assert "tau" in str(exc)


def test_writer_writes_71_lines_in_tmp(tmp_path: Path) -> None:
    out = tmp_path / "cases.jsonl"
    target = write_cases("allowlist71", out_path=out)
    assert target == out
    lines = out.read_text().splitlines()
    assert len(lines) == 71
    reloaded = [json.loads(line) for line in lines]
    assert validate_all_v2(reloaded) == []
    assert [r["case_id"] for r in reloaded] == [
        r["case_id"] for r in build_cases()
    ]


def test_main_writes_and_reports_min_tau(tmp_path: Path, capsys) -> None:
    out = tmp_path / "cases.jsonl"
    assert main(["allowlist71", OUT_FLAG, str(out)]) == 0
    assert len(out.read_text().splitlines()) == 71
    said = capsys.readouterr().out
    assert "71 cases" in said
    assert "min tau" in said
    assert "naca0012_a00_re1200_airfoil" in said


def test_main_usage_on_bad_args() -> None:
    assert main([]) == 2
    assert main(["only", "too", "many", "args"]) == 2


def test_main_rejects_bad_sweep_id(tmp_path: Path) -> None:
    out = tmp_path / "cases.jsonl"
    assert main(["../evil", OUT_FLAG, str(out)]) == 2
    assert not out.exists()


@pytest.mark.parametrize(
    "mutate, fragment",
    [
        ("bad_grid_small", "bad grid"),
        ("bad_u_low", "u_lattice outside"),
        ("mismatched_naca", "must match body suffix"),
        ("bluff_grid_mismatch", "bluff grid must be"),
        ("airfoil_grid_mismatch", "airfoil grid must be"),
        ("hi_re_u_wrong", "needs u 0.12"),
        ("les_u_wrong", "needs u 0.08"),
        ("bgk_re_high", "BGK branch needs Re 20 to 100"),
        ("naca_on_bluff", "must be null"),
        ("missing_branch", "missing branch suffix"),
        ("suffix_body_mismatch", "mismatches"),
    ],
)
def test_validate_v2_row_rejects_corrupted(mutate: str, fragment: str) -> None:
    rows = {str(r["case_id"]): dict(r) for r in build_cases()}
    if mutate == "bad_grid_small":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["nx"] = 2
    elif mutate == "bad_u_low":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["u_lattice"] = 0.005
    elif mutate == "mismatched_naca":
        row = rows["naca0012_a04_re100_airfoil"]
        row["naca_code"] = "2412"
    elif mutate == "bluff_grid_mismatch":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["nx"] = 384
        row["ny"] = 192
    elif mutate == "airfoil_grid_mismatch":
        row = rows["naca0012_a04_re100_airfoil"]
        row["nx"] = 160
        row["ny"] = 128
    elif mutate == "hi_re_u_wrong":
        row = rows["naca0012_a00_re1200_airfoil"]
        row["u_lattice"] = 0.08
    elif mutate == "les_u_wrong":
        row = rows["naca0012_a04_re100_airfoil"]
        row["u_lattice"] = 0.06
    elif mutate == "bgk_re_high":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["re"] = 400.0
    elif mutate == "naca_on_bluff":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["naca_code"] = "0012"
    elif mutate == "missing_branch":
        row = rows["cyl_r020_a00_re020_resolved"]
        row["case_id"] = "cyl_r020_a00_re020"
    else:
        row = rows["naca0012_a04_re100_airfoil"]
        row["case_id"] = "naca0012_a04_re100_les"
    problem = validate_v2_row(row)
    assert problem is not None
    assert fragment in problem


@pytest.mark.parametrize(
    "sweep_id",
    ["", ".", "..", "../evil", "a/b", "a\\b", "/abs", "a:b/c"],
)
def test_sweep_id_sanitation_rejects_paths(sweep_id: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="plain directory name|non empty"):
        write_cases(sweep_id, out_path=tmp_path / "cases.jsonl")


def test_valid_sweep_id_writes_to_tmp(tmp_path: Path) -> None:
    out = tmp_path / "cases.jsonl"
    target = write_cases("allowlist71", out_path=out)
    assert target == out
    assert len(out.read_text().splitlines()) == 71
