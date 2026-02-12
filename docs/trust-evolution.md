# 0.3.0-alpha Trust Evolution (Phases 6–8)

## Phase 6 – Transparency Log (Opt-in)

- Hash-chained JSONL transparency log.
- Deterministic canonicalization.
- Modes: `off | append | verify`.
- No execution or receipt semantic changes.

## Phase 6b – Checkpoints

- Signed checkpoint entries (out-of-band attestation).
- Incremental verification support.
- Strict checkpoint parsing.
- Runtime no longer signs checkpoints; signing is tooling-only.

## Phase 6c – Transparency Head + Monotonicity

- `TransparencyHead` type.
- `compareTransparencyHeads()`.
- `equal | ahead | behind | conflict` semantics.
- No automatic conflict resolution.

## Phase 7 – Distribution Safety

### 7a – Trust Distribution Adapter

- `INTENTOS_TRUST_DISTRIBUTION=off|fs|http`.
- Adapter boundary (snapshot abstraction).
- Default behavior unchanged.

### 7b – Snapshot Acceptance Policy

- `INTENTOS_TRUST_SNAPSHOT_POLICY=off|warn|enforce`.
- Rollback and fork detection via head comparison.
- Reject only in `enforce` mode.

### 7c – Persisted Snapshot State

- `INTENTOS_TRUST_SNAPSHOT_STATE_PATH`.
- Atomic save and strict load.
- Restart-safe rollback protection.

### 7d – Transparency Proof Verification

- Proof = head + optional checkpoint + tail entries.
- Optional HTTP proof fetch inputs.
- Fallback to log-path verification unchanged.

## Phase 8 – Content-Addressed Trust IDs

- `computeBundleId`.
- `computeRevocationsId`.
- `computeAppliedSnapshotId`.
- Metadata-only (no semantic impact).
- Logged as: `intentos_trust_snapshot_applied`.

## Phase 10 – Deterministic Trust Report Tool

- Tool: `tools/trust-report.mjs`.
- NPM script: `npm run trust:report`.
- Outputs stable JSON to stdout with:
  - configured policy/distribution/transparency modes from environment;
  - resolved trust paths;
  - computed trust IDs (when inputs are available);
  - transparency head and optional checkpoint usage (when log/key are provided);
  - optional snapshot state from runtime-format state files.
- No network access is required.
- Volatile timestamp output is opt-in only via `--include-volatile`.

### Usage

```bash
npm run trust:report
```

```bash
node tools/trust-report.mjs --bundle ./examples/trust-bundle.json --log ./tmp/trust-log.jsonl
```

```bash
node tools/trust-report.mjs --env-file ./.env.trust --state ./tmp/trust-snapshot-state.json --include-volatile
```

## Invariants Preserved

- IntentOS execution semantics unchanged.
- Receipt format unchanged.
- Receipt verification crypto semantics unchanged.
- v1 trust semantics frozen.
- v2 enforce semantics unchanged.
- v3 bundle verification semantics unchanged.
- All new trust features are opt-in via environment flags.
