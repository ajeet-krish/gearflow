# Surrogate weights (Phase 3)

This directory hosts the learned U-Net backend. Files are fetched at
runtime only when the user picks the surrogate backend, and any load
failure falls back to the analytic provider.

* `model.json`: shape contract, norm stats, SHA256 (committed after export).
* `weights.bin`: Float32 params in TS forward order (generated, gitignored).
* `model.onnx`: opset 18 export for the future async ORT session path
  (pinned onnxruntime-web dep, never loaded by the sync provider).

Generate locally (user runs, never agents): `npm run gen:dataset`, then
`npm run train`, then `npm run export`. See `training/` for details.

Retired: the v1 files at this root (`model.json` version 1 plus
`weights.bin`) are superseded and no `v2/` bundle ships, so the App pins
neural v2 to unavailable and never fetches them. The only neural path is
`v3/` (unet-v3 ONNX plus norm sidecar), loaded through onnxruntime-web
with its wasm binaries served from `public/ort/`.
