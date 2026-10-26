"""Leakage guard: validation IDs are disjoint from train, norm is train only."""

import json
from pathlib import Path

import pytest

DATA = Path(__file__).parent.parent.parent / "data"


def test_splits_disjoint() -> None:
    manifest = DATA / "manifest.jsonl"
    if not manifest.exists():
        pytest.skip("data/ absent, run gen:dataset first")
    train_ids: set[str] = set()
    val_ids: set[str] = set()
    for line in manifest.read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        target = train_ids if entry["split"] == "train" else val_ids
        assert entry["id"] not in train_ids and entry["id"] not in val_ids, f"duplicate id {entry['id']}"
        target.add(entry["id"])
    assert len(train_ids) > 0 and len(val_ids) > 0
    assert train_ids.isdisjoint(val_ids), "leakage: train and val share ids"
