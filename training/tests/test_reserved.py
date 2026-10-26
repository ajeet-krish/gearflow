"""Reserved anchor guard: naca4 near 0012/2412 thickness at 4/6/8 deg stays out of train."""

from dataset import RESERVED_ALPHAS, RESERVED_KINDS, is_reserved_combo


def test_reserved_kinds_and_alphas_pinned() -> None:
    assert RESERVED_KINDS == {"naca4"}
    assert RESERVED_ALPHAS == {4.0, 6.0, 8.0}


def test_naca4_anchor_combo_is_reserved() -> None:
    assert is_reserved_combo({"kind": "naca4", "alpha": 6.0, "thick": 0.12})
    assert is_reserved_combo({"kind": "naca4", "alpha": 4.0, "thick": 0.121})
    assert is_reserved_combo({"kind": "naca4", "alpha": 8.0, "thick": 0.119})


def test_non_anchor_combos_are_not_reserved() -> None:
    assert not is_reserved_combo({"kind": "naca4", "alpha": 6.0, "thick": 0.15})
    assert not is_reserved_combo({"kind": "naca4", "alpha": 2.0, "thick": 0.12})
    assert not is_reserved_combo({"kind": "cylinder", "alpha": 6.0, "thick": 0.12})
    assert not is_reserved_combo({"kind": "duct", "alpha": 0.0})
