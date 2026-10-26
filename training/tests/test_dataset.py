"""Dataset integrity: shard layout, channel shapes, manifest consistency."""

from pathlib import Path

import numpy as np
import pytest

DATA = Path(__file__).parent.parent.parent / "data"


def test_shards_exist_and_read() -> None:
    if not (DATA / "train").exists():
        pytest.skip("data/ absent, run gen:dataset first")
    shards = sorted((DATA / "train").glob("shard-*.npz"))
    assert len(shards) >= 1, "no shards found, run gen:dataset first"
    with np.load(shards[0]) as z:
        names = z.files
        assert len(names) > 0
        arr = z[names[0]]
        assert arr.shape == (6, 128, 128), f"unexpected sample shape {arr.shape}"
        assert arr.dtype == np.float32
        assert np.isfinite(arr).all()
