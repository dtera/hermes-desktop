# Model context window

A model can carry an optional manual context-window override (tokens), for providers that don't advertise `context_length` over `/models` — without it the desktop can't size the context gauge or the agent's auto-compaction.

The same value fixes two symptoms at once: the context gauge showing a wrong heuristic size (e.g. 32k for a 64k model), and the agent never auto-compacting. hermes-agent auto-compacts at `context_length × compression.threshold` (default 0.50, enabled by default), so a correct `context_length` re-enables compaction without any extra UI.

## Storage and propagation

The override is stored per-model in `models.json` as `contextLength` and mirrored into `config.yaml`'s `model.context_length` whenever a model is activated — the single value both the gauge and the agent read.

Per-model storage (set in the Models add/edit dialog) survives switching between models. On activation, [[src/main/config.ts#setModelConfig]] writes or clears `model.context_length` from the activated model's library entry; an absent override clears any stale value left by a previously-active model. Remote/SSH activation does not propagate the override yet (local-mode only).

## Gauge resolution order

The context gauge resolves its window size as: config override (active model) → provider `/models` `context_length` → static heuristic.

[[src/main/model-discovery.ts#getModelContextWindow]] consults [[src/main/config.ts#getModelContextLengthOverride]] first, returning it only when it targets the model being asked about (so a stale value can't leak onto a different model id), before falling through to the authoritative `/models` lookup and finally the renderer's substring heuristic.
