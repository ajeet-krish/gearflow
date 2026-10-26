"""Training dataset: loads analytic shards, splits by manifest, guards leakage.

Channel layout per sample (6, 128, 128) float32: [sdf, mask, alpha, u, v, cp].
Inputs are channels 0..2 (sdf clipped to [-3, 3], mask 0/1, alpha in deg),
targets are channels 3..5 (u, v, cp with p normalized by 0.5 U^2).

Normalization stats come from the train split only. The leakage guard
asserts the validation ID set is disjoint from train and that reserved
anchor combos (naca4 near 0012/2412 thickness at 4, 6, 8 deg, the panel's
PASS check points) never appear in train.
"""

import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

NX = 128
NY = 128
ALPHA_SCALE = 12.0

# Reserved anchor combos, held out of train by construction in gen_dataset.
# A sample is reserved when it is a naca4 airfoil near the 0012/2412
# thickness (0.12) at one of the panel PASS alphas (4, 6, 8 deg).
RESERVED_KINDS = {"naca4"}
RESERVED_ALPHAS = {4.0, 6.0, 8.0}
RESERVED_THICK = 0.12
RESERVED_THICK_TOL = 0.005


def is_reserved_combo(entry: dict) -> bool:
    """True when a manifest entry hits the held-out validation anchor."""
    if entry.get("kind") not in RESERVED_KINDS:
        return False
    try:
        alpha = float(entry.get("alpha", float("nan")))
    except (TypeError, ValueError):
        return False
    if alpha not in RESERVED_ALPHAS:
        return False
    thick = entry.get("thick", entry.get("t", None))
    if thick is None:
        # No thickness recorded: treat any naca4 anchor alpha as reserved
        # so the guard stays conservative on legacy manifests.
        return True
    try:
        return abs(float(thick) - RESERVED_THICK) <= RESERVED_THICK_TOL
    except (TypeError, ValueError):
        return True


def _require_geometry_fields(entry: dict, entry_id: str) -> None:
    for key in ("id", "split", "shard", "kind", "alpha"):
        if key not in entry:
            raise ValueError(f"manifest entry {entry_id} missing geometry field {key!r}")
    if entry["split"] not in ("train", "val"):
        raise ValueError(f"manifest entry {entry_id} has bad split {entry['split']!r}")
    if not isinstance(entry["shard"], int) or entry["shard"] < 0:
        raise ValueError(f"manifest entry {entry_id} has bad shard {entry['shard']!r}")


class SurrogateDataset(Dataset):
    def __init__(self, data_dir: Path, split: str, norm: dict | None = None):
        if split not in ("train", "val"):
            raise ValueError(f"split must be train or val, got {split}")
        self.split = split
        self.data_dir = Path(data_dir)
        manifest_path = self.data_dir.parent / "manifest.jsonl"
        entries = []
        with open(manifest_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
        for e in entries:
            _require_geometry_fields(e, str(e.get("id", "?")))
        wanted = [e for e in entries if e["split"] == split]
        if not wanted:
            raise ValueError(f"no manifest entries for split {split}")
        if split == "train":
            reserved = [e["id"] for e in wanted if is_reserved_combo(e)]
            if reserved:
                raise ValueError(
                    f"leakage: {len(reserved)} reserved anchor combos in train, e.g. {sorted(reserved)[:3]}"
                )
        self.ids = [e["id"] for e in wanted]
        self.by_id = {e["id"]: e for e in entries}
        self.norm = norm or self._fit_norm(wanted)
        self._entries = wanted

    def _load_sample(self, entry: dict) -> np.ndarray:
        shard = self.data_dir / f"shard-{entry['shard']:03d}.npy"
        # Support both layouts: shard-*.npz written by gen_dataset, and
        # a bare shard-*.npy fallback used by unit tests.
        if shard.with_suffix(".npz").exists():
            shard = shard.with_suffix(".npz")
        with np.load(shard) as z:
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

    def _fit_norm(self, wanted: list[dict]) -> dict:
        # Welford-lite over train only: mean of means is exact for equal shapes.
        n = 0
        sdf_sum = mask_sum = alpha_sum = 0.0
        u_sum = v_sum = cp_sum = 0.0
        sdf_sq = u_sq = v_sq = cp_sq = 0.0
        count = 0
        for entry in wanted:
            s = self._load_sample(entry)
            sdf = np.clip(s[0], -3, 3)
            u, v, cp = s[3], s[4], s[5]
            m = s[0].size
            sdf_sum += sdf.sum()
            u_sum += u.sum()
            v_sum += v.sum()
            cp_sum += cp.sum()
            sdf_sq += (sdf * sdf).sum()
            u_sq += (u * u).sum()
            v_sq += (v * v).sum()
            cp_sq += (cp * cp).sum()
            count += m
            n += 1
        mean = lambda tot: float(tot / count)
        std = lambda tot_sq, mu: float(max(np.sqrt(tot_sq / count - mu * mu), 1e-6))
        sdf_mean = mean(sdf_sum)
        u_mean = mean(u_sum)
        v_mean = mean(v_sum)
        cp_mean = mean(cp_sum)
        return {
            "sdfMean": sdf_mean,
            "sdfStd": std(sdf_sq, sdf_mean),
            "alphaScale": ALPHA_SCALE,
            "uMean": u_mean,
            "uStd": std(u_sq, u_mean),
            "vMean": v_mean,
            "vStd": std(v_sq, v_mean),
            "cpMean": cp_mean,
            "cpStd": std(cp_sq, cp_mean),
            "nFit": n,
        }

    def assert_no_leakage(self, other_ids: set[str], split: str | None = None) -> None:
        """Disjoint-ID check always runs; the reserved-anchor check runs only
        for the train split (gen_dataset assigns reserved anchors to val by
        construction, so checking val would false-positive)."""
        overlap = set(self.ids) & set(other_ids)
        if overlap:
            raise ValueError(f"leakage: {len(overlap)} ids in both splits, e.g. {sorted(overlap)[:3]}")
        effective = split if split is not None else self.split
        if effective != "train":
            return
        reserved = [e["id"] for e in self._entries if is_reserved_combo(e)]
        if reserved:
            raise ValueError(
                f"leakage: {len(reserved)} reserved anchor combos in split, e.g. {sorted(reserved)[:3]}"
            )

    def __len__(self) -> int:
        return len(self._entries)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        entry = self._entries[idx]
        s = self._load_sample(entry)
        norm = self.norm
        sdf = (np.clip(s[0], -3, 3) - norm["sdfMean"]) / norm["sdfStd"]
        mask = s[1]
        alpha = np.full_like(s[0], s[2].mean() / norm["alphaScale"])
        x = np.stack([sdf, mask, alpha]).astype(np.float32)
        u = (s[3] - norm["uMean"]) / norm["uStd"]
        v = (s[4] - norm["vMean"]) / norm["vStd"]
        cp = (s[5] - norm["cpMean"]) / norm["cpStd"]
        y = np.stack([u, v, cp]).astype(np.float32)
        if x.shape != (3, NY, NX) or y.shape != (3, NY, NX):
            raise ValueError(f"sample {entry['id']} channel shape mismatch")
        if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y))):
            raise ValueError(f"sample {entry['id']} normalized values non-finite")
        return torch.from_numpy(x), torch.from_numpy(y)
