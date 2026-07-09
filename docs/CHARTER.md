# Quorum Charter — what Quorum protects, and why

> **Status of this document.** This charter is *why* Quorum exists and *what it protects*. It sits above [`docs/PRINCIPLES.md`](PRINCIPLES.md) (the twelve *how* principles) and the ADRs (specific decisions). It is prose, and prose is debt (principle 2) — so it states mission and calibration, which cannot be a check, and defers every mechanism to the code and principles that enforce it. Where this charter names something as shipped, it is on `main` and runnable from source; where it names something as intended, it says so. Quorum's predecessor failed by describing enforcement it had not shipped, and this charter is held to that same inverse standard: it does not describe protection Quorum has not yet built.

---

## 1. The one sentence

**Quorum exists so that a claim cannot reach a decision-maker unless deterministic code has independently verified it against committed bytes.**

Everything else — the tiers, the cross-family red-team, the fail-closed kernel, the Gate — is machinery in service of that one guarantee. When the guarantee is threatened, the machinery yields to it, not the other way around.

## 2. What Quorum protects

Quorum protects **the integrity of claims**. A claim is any assertion about state that something downstream will act on: *this file exists, this commit landed, this test passed, this config is at this risk tier, this review happened.* The failure Quorum was built to prevent is a claim that is **asserted but not true** — trusted because someone (a human, or increasingly an AI agent) said it, rather than because it was checked.

The thing being protected is not the repository. It is **whatever rests on the repository's claims one level up.** Quorum is domain-general verification infrastructure: a product built on Quorum inherits the guarantee that any claim reaching its end user survived deterministic verification rather than asserted trust. "Verify, don't trust" (principle 1) is not only an internal discipline — it is a property the infrastructure hands to its consumers.

## 3. Why it exists — the founding failure

Quorum's predecessor (AMAS) failed in two ways that this charter names so they are never repeated:

1. **It described enforcement it never shipped.** Rules lived in prose that read as if they were checks. The map was mistaken for the territory. Principle 2 ("enforce in code, document in prose") and the honesty standard on every doc — including this one — are the direct correction.
2. **The human was the transport.** The owner hand-relayed artifacts between disconnected AI surfaces, losing context and becoming the bottleneck (ADR-0001). Principle 4 ("shared substrate, not a human relay") is the correction.

Quorum was founded specifically to close the first gap: to make the guarantee in §1 real in deterministic code, not asserted in prose. Every task in the program is measured against whether it closes that gap or merely describes closing it.

## 4. The load-bearing consumer, and the calibration it forces

Quorum is domain-general, but it is **not** built in the abstract. Its **first consumer is tooling for human performance — sport science.** This is deliberate, and it is load-bearing for calibration, not a footnote:

**When a downstream product informs a decision about a human's health, training, or performance, the cost of a silently-wrong verified claim is a decision made about a person's body on false premises.** A claim that Quorum verified and passed can reach an athlete or a coach and drive a training load, a recovery protocol, a return-to-play call. That is the blast radius that sets the calibration.

From this follows the **operative rule of every fail-closed decision in Quorum:**

> **A silently-wrong verified claim (an under-floor — grading something at a lower risk tier than it deserves, so it slips through with too little ceremony) is the worst outcome. It is worse than an over-cautious block.** An over-cautious block costs a maintainer some friction and a second look. An under-floor lets a wrong claim through wearing the badge of having been verified — and that badge is exactly what a downstream consumer, and ultimately an athlete or coach, is entitled to trust.

This is why, everywhere Quorum faces an unresolvable reference, an unreadable policy, an unknown git mode, a malformed tree, a policy that can't be provenance-checked — **it blocks, it does not silently pass** (principle 12: safety-critical checks fail closed). Ceremony scales with what a wrong claim costs the end user (principle 3), and for a human-performance consumer that cost is high, so the calibration leans conservative by default.

A concrete, committed instance: in QRM-4.0-compare, a malformed tree-truncation flag was adjudicated as a BLOCK rather than accepted, precisely because a partial tree could drop a symlink or gitlink leaf and under-floor a change — the calibration in this section decided that adjudication. (See `docs/handoffs/QRM-4.0-compare-review.md`.)

**Domain-general, but calibrated for the highest-stakes consumer it currently serves.** As Quorum takes on consumers whose wrong-claim cost is lower, tier calibration may be relaxed *for those consumers* — but never below the floor that the human-performance consumer requires of the shared kernel, and never by a change that a consumer's PR can influence.

## 5. The determinism line — what may block, and what may not

The single hardest boundary in Quorum:

> **Only deterministic code, reading committed bytes, may block a merge.**

The reason is independence, and it follows from principle 7. Judges drawn from the same model family share training, blind spots, and failure modes, so their errors correlate: adding more of them yields sharply diminishing independence, and a panel — however large — cannot be assumed to approach the reliability its headcount suggests. Cross-family review (principle 7) exists precisely because independence must be bought structurally, not by repetition; it is *mandatory* for trust-boundary changes and it catches real defects — but even cross-family review reduces correlated error rather than eliminating it. It **advises**; it does not floor. A deterministic check has the property no panel of judges can offer: it runs the same way every time, and anyone can re-run it from a clean clone and get the same answer. That is why the deterministic kernel is the only true floor, and why Quorum invests its rigor there: the verifier, the tier floor, the coverage computation, the forge parity — the parts that can be re-checked from committed bytes.

A corollary that has been ratified into the program: **no PR-influenced state may enter the verifier's execution context.** Caches, build artifacts, restored dependencies — anything a pull request can shape — is kept out of the trusted execution path. The verifier runs pinned code on committed bytes, or it is not trusted (this is item [3] on the path to the Gate, carrying the cache-poisoning amendment).

## 6. Verify, don't trust — including our own records

The discipline turns inward. **A handoff document is a claim, not ground truth.** The source of truth is always a clean clone of `main`, read as committed bytes — never a handoff summary, never a prior chat, never a Builder's report that a branch was pushed. Discrepancy between what a document says and what the repository contains is *expected*, and catching it at re-gate is the discipline working, not a surprise.

This charter included: if it ever describes protection that the repository does not contain, the repository is right and this charter is stale. Reconcile to the bytes.

## 7. What is shipped, and what is intended (honest status)

Per principle 2, the line is drawn explicitly.

**Shipped and runnable from `main` today:**
- **L0 contracts** and the **L1 deterministic verification kernel** — the claim verifier and the `quorum` CLI (`verify` / `tier` / `validate`), offline (`--local`).
- **Deterministic tier floors on agent-configuration changes** (QRM-3.0 through 3.4): the agent-config floor; mode-aware floors (symlink / gitlink → high tier); policy-from-base at the canonical fork point; harness-config coverage; and delegated/transitive reference floors.
- **Authenticated forge parity** for the diff and file-listing surface the Gate will consume (QRM-4.0-compare): tree-diff-primary compare and listing, fail-closed.
- **Authenticated base-policy read** (QRM-4.0 prerequisite [1]): the forge-mode counterpart of policy-from-base — the fork point resolved from the forge, the policy read at that resolved commit and validated, fail-closed on every unresolvable or malformed path. This is capability behind the `PolicySource` seam, not yet routed into enforcement; routing is the Gate's job.

**Specified, not yet built — named as such:**
- The **L2 enforcement Gate** — a required status check that actually blocks a merge — is **not yet live.** Its remaining prerequisites are tracked, in sequence: mechanical branch-freshness, trusted/pinned verifier code, then wiring the required check. Until every prerequisite lands, completeness is not claimed.
- **App-as-identity** (the `quorum-gate` GitHub App) is not yet provisioned.

Quorum today verifies and floors; it does not yet *enforce at merge*. Saying so plainly is the charter honoring the failure that created it.

## 8. The shape of trust — who does what

Trust in Quorum is deliberately distributed so that no single party is both the actor and the verifier of its own claim:

- The **Architect** designs, pressure-tests, prototypes, and gates from committed bytes — and **never merges.**
- The **Builder** implements under direction and **holds at hand-back** — it never merges, and a "committed" branch that is only in the worktree ships nothing (PMN-002).
- The **cross-family red-team** adversarially reviews trust-boundary changes (PMN-001) — mandatory, and its BLOCKs are adjudicated and fixed, never waved through.
- The **human owner** holds **sole merge authority.** The human is the accountability gate, not the transport (principle 4).
- The **deterministic verifier** — not an LLM — is the only thing that floors.

Independence is the point: the builder and the reviewer come from different model families, and it matters *more* the less a human relays between them (principle 7).

## 9. How this charter is kept honest

This document is durable, not frozen, and the same two disciplines that govern every other artifact govern it: **a claim in this charter is promoted only on evidence from outside the pipeline that produced it (principle 10), and any statement here that stops earning its place is retired rather than preserved (principle 11).** A charter sentence that stops matching the committed system is a defect to reconcile, not a truth to defend. The Fable 5 third-family audit at the Gate boundary reads this charter as the committed statement of what Quorum protects and what a wrong claim costs — and judges whether the calibration in §4 is conservative *enough* for the consumer in §4. That judgment is only possible because this charter is committed bytes, not chat.

---

*This charter is the apex of Quorum's self-description. Below it: [`docs/PRINCIPLES.md`](PRINCIPLES.md) (the twelve principles), [`docs/adr/`](adr/) (ratified decisions), and the task handoffs in [`docs/handoffs/`](handoffs/) (the committed history of the work). Above it: nothing — this is where "why" lives.*
