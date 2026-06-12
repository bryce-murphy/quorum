# Contributing to Quorum

> **Stub.** Quorum is at bootstrap; the contribution process is not yet finalized. This file states the intent so early contributors and the spec session share expectations. It will be filled out when Phase 1 ships.

## Current phase

Quorum is being **specified**, not yet built. The most valuable contribution right now is review of the design:

1. Read `docs/PRINCIPLES.md` (the spine).
2. Read `docs/adr/ADR-0001-founding-decisions.md` (what's already decided and why).
3. Read `docs/SPEC-HANDOFF.md` (the architecture being specified).

Open an issue to challenge a principle, a founding decision, or the architecture. Disagreement that names a concrete failure mode is the most useful kind.

## How Quorum will accept contributions (planned)

Quorum dogfoods itself: contributions flow through Quorum's own process once it exists.

- Every change threads a stable task ID through issue → branch → handoff → PR.
- Branch naming, PR template, and required checks are enforced by Actions (not by reviewer memory).
- The Builder and Reviewer on any non-trivial change are different model families (principle 7).
- Ceremony scales with risk tier (principle 3): a typo is near-zero ceremony; an architectural change gets the full pipeline plus an ADR.
- The human owner holds merge authority.

## Ground rules (in force now)

- **Never commit secrets.** Tokens, keys, credentials, confidential payloads stay out of the repo and out of artifacts. Reference-and-summarize instead.
- **No undefined vocabulary.** Any new term in canonical text gets a `docs/GLOSSARY.md` entry in the same change.
- **No prose enforcement.** If you propose a rule that can be checked, propose the check, not just the prose (principle 2).
- **Decisions are durable.** Architectural decisions land as ADRs and are superseded, not edited in place.

## Code of conduct

Be direct, be kind, attack ideas not people. A fuller code of conduct lands with Phase 1.
