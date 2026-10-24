# Audit hardening

Source: the 2026-10-24 audit of the frozen engineering-compiler v0.1 design corpus
(`/tmp/opencode/ec-design-audit-2026-10-24/REPORT.md`). The audit reviewed a design
corpus, not this plugin, but several findings were referee-layer failures: a gate
accepted evidence without provenance, a status said "needs you" before the question
was delivered, and a root's release record omitted its subsystems' unresolved work.
Those classes are now invariants here.

## Invariants added

| Audit lesson | Failure mode it prevents | Plugin invariant | Test |
| --- | --- | --- | --- |
| C-04, H-10: gate evidence had no producer/independence check | The Architect's own artifact could back the Falsifier's finding | `design_record_evidence` stores `recorded_by`; a finding citing an Architect-recorded strong artifact is downgraded to `hypothesis` | `test/core.test.ts` ("a Falsifier finding cannot be backed by the Architect's own evidence") |
| M-23: evidence was not bound to a commit/tag | A design verdict could cite output from an unrelated tree state | Evidence records carry `commit` and exact-match `tag` (best effort; null outside git) | `test/scale.e2e.test.ts` ("a recorded artifact with a masked exit or contradictory output is flagged") |
| L-02: an exit-0 record contained `[FAIL]` / `SOME CHECKS FAILED` | A masked exit or contradictory artifact could gate convergence | `evidenceProblem` marks the record `suspect`; `unbackedReason` refuses it | `test/core.test.ts` ("a contradictory or masked-exit artifact cannot back a claim") |
| H-13, M-24: a ratified/accepted issue was not carried into the parent ledger | A root looked clean while a subsystem carried an accepted risk or open finding | The root's child summary carries `risks` and unresolved `findings`; `08-open-issues.md` renders both with the subsystem id | `test/core.test.ts` ("carries a child's accepted risk and open findings into the root ledger"), `test/scale.e2e.test.ts` ("root hand-off lists subsystem loose ends") |
| H-04/H-11 class: cross-root state was invisible at the root | The root's hand-off omitted a subsystem's loose ends | `subsystem_loose_ends` continues to include both unresolved and accepted child findings; the hand-off now also has the structured child summary | same hand-off test |
| Delivery reliability (plugin observation) | `notified` was set before the Referee prompt was attempted, so a failed prompt still showed "needs you" | `notified` is set only after the prompt succeeds; failures set `delivery_error` and stay retryable | `test/scale.e2e.test.ts` ("an escalation is not marked delivered when the Referee prompt fails") |
| TUI readability (plugin observation) | A pending-but-undelivered question was hidden or looked settled | `needsYou` requires `notified === true`; `deliveryPending` keeps the effort visible, leads it, ranks it above settled work, and shows "delivery pending" | `test/tui-runs.test.ts` |

## Semantics

- **"Needs you"** means the Referee prompt that carries the question was accepted by
  the host. It does not claim the agent has already called the `question` tool; the
  protocol requires that call, and the TUI distinguishes an undelivered escalation as
  `delivery pending`.
- **Evidence provenance** is local-trust metadata, not authentication. The workspace
  is single-user and has no token/principal layer; `recorded_by` is the role the
  plugin resolved from the managed session.
- **Legacy records** without `recorded_by` are accepted as-is. The stricter check
  applies only to records that carry a role, so existing v0.1 run state remains
  readable.
- **Suspect evidence** is still recorded and visible; it simply cannot back a binding
  finding. Fix the command or rerun it without a masked exit code.

## Deliberately not added

- A retry timer for failed deliveries. Failed deliveries are retried on the next
  state change and on plugin restart; the TUI exposes the pending state so the user
  can prompt a retry. A background retry loop would duplicate the watchdog scheduler
  for a failure that is normally a dead session.
- A hard requirement that every review log entry exists. The Falsifier owns
  `07-review-log.md`; the plugin records the structured verdicts and evidence, so a
  missing prose entry does not hide a gate result.
