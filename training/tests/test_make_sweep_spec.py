"""Tests for training/make_sweep_spec.py, the 60 case sweep spec generator.

No Modal, no network, no randomness. The suite pins the 60 row count,
unique ids, CaseSpecV1 validity, ref_length presence, grids, u mapping,
and the recorded design decision: Re 100 bluff body BGK rows are absent
(the pilot short tunnel BGK pair diverged), with 12 LES branch rows
covering high Re bluff instead.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_sweep_spec import build_cases, validate_all, validate_case, write_cases


def _by_id(rows: list[dict]) -> dict[str, dict]:
    return {str(row["case_id"]): row for row in rows}


def test_row_count_is_60() -> None:
    assert len(build_cases()) == 60


def test_ids_unique_and_deterministic() -> None:
    first = build_cases()
    second = build_cases()
    assert [r["case_id"] for r in first] == [r["case_id"] for r in second]
    assert [json.dumps(r, sort_keys=True) for r in first] == [
        json.dumps(r, sort_keys=True) for r in second
    ]
    ids = [str(r["case_id"]) for r in first]
    assert len(set(ids)) == 60


def test_required_keys_present() -> None:
    expected = {
        "case_id", "body", "re", "u_lattice", "alpha_deg", "les",
        "nx", "ny", "domain_width", "radius", "width", "height",
        "naca_code", "ref_length", "transient", "window",
        "substitutes_for", "note",
    }
    for row in build_cases():
        assert set(row.keys()) == expected


def test_all_rows_validate_clean() -> None:
    rows = build_cases()
    assert validate_all(rows) == []
    for row in rows:
        assert validate_case(row) is None


def test_ref_length_present_and_correct() -> None:
    for row in build_cases():
        ref = float(row["ref_length"])
        assert ref > 0.0
        body = str(row["body"])
        if body == "cylinder":
            assert abs(ref - 2.0 * float(row["radius"])) < 1e-12
        elif body == "block":
            assert abs(ref - float(row["width"])) < 1e-12
            assert abs(ref - float(row["height"])) < 1e-12
        elif body in ("naca0012", "naca2412", "naca4"):
            assert abs(ref - 1.0) < 1e-12
        elif body == "duct":
            assert abs(ref - float(row["height"])) < 1e-12
        elif body == "orifice":
            assert abs(ref - 0.4) < 1e-12


def test_u_mapping_bgk_060_les_080() -> None:
    for row in build_cases():
        if row["les"] is True:
            assert abs(float(row["u_lattice"]) - 0.08) < 1e-12
        else:
            assert abs(float(row["u_lattice"]) - 0.06) < 1e-12


def test_grids_and_windows() -> None:
    for row in build_cases():
        assert int(row["transient"]) == 8000
        assert int(row["window"]) == 12000
        assert row["substitutes_for"] is None
        body = str(row["body"])
        if body in ("naca0012", "naca2412", "naca4"):
            assert int(row["nx"]) == 256
            assert int(row["ny"]) == 128
            assert abs(float(row["domain_width"]) - 2.55) < 1e-12
        else:
            assert int(row["nx"]) == 160
            assert int(row["ny"]) == 128
            assert abs(float(row["domain_width"]) - 4.0) < 1e-12


def test_branch_counts() -> None:
    rows = build_cases()
    cyl = [r for r in rows if r["body"] == "cylinder"]
    block = [r for r in rows if r["body"] == "block"]
    air = [r for r in rows if str(r["body"]).startswith("naca")]
    duct = [r for r in rows if r["body"] == "duct"]
    ori = [r for r in rows if r["body"] == "orifice"]
    assert len(cyl) == 12
    assert len(block) == 10
    assert len(air) == 30
    assert len(duct) == 6
    assert len(ori) == 2


def test_re100_bluff_bgk_excluded_with_les_coverage() -> None:
    rows = build_cases()
    bad = [
        r for r in rows
        if str(r["body"]) in ("cylinder", "block")
        and abs(float(r["re"]) - 100.0) < 1e-12
        and r["les"] is False
    ]
    assert bad == []
    bluff_les = [
        r for r in rows
        if str(r["body"]) in ("cylinder", "block")
        and r["les"] is True
        and float(r["re"]) >= 100.0
    ]
    assert len(bluff_les) == 12
    cyl_les = sorted(
        r["case_id"] for r in bluff_les if r["body"] == "cylinder"
    )
    block_les = sorted(
        r["case_id"] for r in bluff_les if r["body"] == "block"
    )
    assert len(cyl_les) == 6
    assert len(block_les) == 6
    for case_id in cyl_les + block_les:
        row = _by_id(rows)[str(case_id)]
        assert abs(float(row["u_lattice"]) - 0.08) < 1e-12


def test_spec_file_roundtrip(tmp_path: Path) -> None:
    out = tmp_path / "cases.jsonl"
    target = write_cases("pilot60", out_path=out)
    assert target == out
    lines = out.read_text().splitlines()
    assert len(lines) == 60
    rows = [json.loads(line) for line in lines]
    assert validate_all(rows) == []
    assert [r["case_id"] for r in rows] == [r["case_id"] for r in build_cases()]


def test_source_has_no_banned_punctuation() -> None:
    src = (Path(__file__).resolve().parent.parent / "make_sweep_spec.py").read_text()
    assert chr(8212) not in src
    assert chr(8211) not in src
    dd = chr(45) + chr(45)
    assert dd not in src


@pytest.mark.parametrize(
    "mutate, fragment",
    [
        ("bad_grid_small", "bad grid"),
        ("bad_grid_huge", "bad grid"),
        ("bad_u_low", "u_lattice outside"),
        ("bad_u_high", "u_lattice outside"),
        ("mismatched_naca", "naca_code must match body suffix"),
    ],
)
def test_validate_case_rejects_corrupted_rows(mutate: str, fragment: str) -> None:
    rows = {str(r["case_id"]): dict(r) for r in build_cases()}
    if mutate in ("bad_grid_small", "bad_grid_huge"):
        row = rows["cyl_r015_re020"]
        if mutate == "bad_grid_small":
            row["nx"] = 2
        else:
            row["nx"] = 1024
            row["ny"] = 512
    elif mutate in ("bad_u_low", "bad_u_high"):
        row = rows["cyl_r015_re020"]
        row["u_lattice"] = 0.005 if mutate == "bad_u_low" else 0.5
    else:
        row = rows["naca0012_a00_re100"]
        assert str(row["body"]) == "naca0012"
        row["naca_code"] = "2412"
    problem = validate_case(row)
    assert problem is not None
    assert fragment in problem
