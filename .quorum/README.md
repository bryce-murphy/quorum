# `.quorum/` - git-native operational home

This directory is the **default, zero-dependency home** for Quorum's operational
state, committed to git and schema-validated in CI (principle 5; ADR-0001 Decision 5).
It is canonical and diff-reviewable. An external `DataStore` adapter, when a project
opts into one, indexes or caches this - it never replaces it.

Planned contents (schemas land with the spec session; these are placeholders):

- `graph/`     - task and decision graph nodes/edges
- `ledger/`    - claim ledger of record (claims + verification status)
- `telemetry/` - per-cycle token spend, wall-clock, artifact count, findings-by-surface
- `audit/`     - identity-attributed agent action log

`scratch/` and `cache/` are gitignored (ephemeral); everything else here is committed.
