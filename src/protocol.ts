// The agent-facing operational contract, defined in code so it versions with the enforcement.
export const PROTOCOL = `# Crucible Protocol

Operational contract for the Crucible adversarial design loop. The injected
\`architect\` and \`falsifier\` agents follow this document; the \`crucible\` Referee
runs the loop. The process is enforced by the plugin
(\`server.ts\`, with the pure rules in \`core.ts\`); agents act through the
\`design_*\` tools, which own all state. Agents must not write state files
directly.

## Roles

- **Architect** (generator): writes and revises the design artifacts and
  responds to open findings. Must attempt to refute each finding before
  accepting it ("falsify the falsifier").
- **Falsifier** (discriminator): attacks the design, records evidence, and
  submits a structured verdict. Never edits design artifacts.
- **Referee** (the \`crucible\` agent): bootstraps the run, dispatches agents,
  validates findings, tracks convergence and budgets, and stops the loop. Never
  designs or attacks.
- **User**: ground truth. Confirms the requirement ledger, can inject
  constraints, veto, adjudicate escalations, pause/resume, and stop.

## How it runs

The plugin keeps **one long-lived child session per role per run** (an
Architect session and a separate Falsifier session), created on the role's first
dispatch and reused for every later round via \`promptAsync\`. The Architect
session retains the design it wrote and the Falsifier session retains its prior
reviews, so they do not re-orient or re-read the workspace each round; the two
roles stay separate, so the Falsifier never sees the Architect's rationale.
Context growth is handled by compaction (the plugin's \`compacting\` hook injects
the run state).

Each agent gets its hand-off via \`design_get_context\` (recommended on every
turn; the full protocol read is only requested on the role's first dispatch),
does its work, then calls its terminal tool (\`design_respond\` for the Architect,
\`design_submit_verdict\` for the Falsifier) before ending its turn. The plugin
advances on session idle, with pending-attempt tracking, a watchdog, and a
single retry per dispatch. The watchdog measures **inactivity, not duration**:
any streamed output, tool call, status change, or permission event resets the
window (default 10 min, 30 min while a tool call runs; per-run \`watchdog_ms\` or plugin \`watchdogMs\`), so a long
but active turn is never interrupted for taking long. Only a turn that goes
silent past the window is aborted and retried once, then the run stops with
\`no_progress\` (\`stop_reason: watchdog_timeout\`). Child shell commands run without prompts under the \`guarded\` policy: directories outside the project are denied except the scratch directory, repeated identical calls and \`.env\` reads are denied, and a blocklist refuses destructive, remote-affecting, and repository-changing git commands. It is not a sandbox, so commit your work before a run. Processes an agent starts are killed when its turn ends; containers started with \`docker run\` or \`podman run\` are removed then too, so prefer \`--rm\`. Each run has its own scratch directory (given in the dispatch and as \`$CRUCIBLE_SCRATCH\`) for evidence scripts and data.

## Run layout

\`\`\`
docs/design/<slug>/
  00-brief.md            (plugin)
  01-requirements.md     (plugin, from the ledger)
  02-constraints-assumptions.md
  03-architecture.md
  04-decisions.md
  05-risks.md
  06-operability.md
  07-review-log.md       (Falsifier)
  08-open-issues.md      (plugin, on terminal)
  .crucible/
    state.json
    verdicts/round-<NN>.json
    responses/round-<NN>.json
    evidence/E-<NNN>.json
\`\`\`

Create artifacts lazily, but never skip \`00-brief.md\`, \`01-requirements.md\`,
\`03-architecture.md\`, and \`07-review-log.md\`.

## Phases

\`eliciting → designing → (falsifying → responding)* → terminal\`

- \`eliciting\`: the Referee elicits requirements (\`design_add_requirement\`).
- \`designing\`: the Architect produces or revises the design.
- \`falsifying\`: the Falsifier reviews and submits a verdict.
- \`responding\`: the Architect responds to the verdict and produces the next
  revision; validation and convergence are computed immediately.
- Terminal: \`converged | accepted_with_reservations | budget_stopped |
  no_progress | blocked | stopped\`.

A separate boolean \`paused\` suspends dispatch without changing the phase. Tools
remain usable while paused; \`design_dispatch\` refuses until \`design_resume\`.
\`design_resume\` also reopens a run that was \`stopped\` by the user, restoring the
phase it was stopped from (recorded as \`stopped_from\`).

## Tools

The \`design_*\` tools are the only write path:

\`design_start\`, \`design_add_requirement\`, \`design_amend_requirement\`, \`design_confirm_requirements\`,
\`design_begin_round\`, \`design_record_evidence\`, \`design_record_decision\`,
\`design_submit_verdict\`, \`design_respond\`, \`design_dispatch\`, \`design_decompose\`,
\`design_decide\`, \`design_escalations\`, \`design_status\`, \`design_list\`,
\`design_get_context\`, \`design_protocol\`, \`design_pause\`, \`design_resume\`,
\`design_stop\`, \`design_config\`.

Agents load this document with the \`design_protocol\` tool on their first
dispatch; it is defined in the plugin code, so it always matches the running
version.

### Decomposition (large systems)

A run started with \`design_start({ decompose: true })\` is a **root**: it owns the
system ledger, the decomposition, and integration. After its own rounds stabilize
it enters the non-terminal hold \`awaiting_decomposition\`. The **Architect** writes
\`docs/design/<root>/decomposition.json\` as part of its design; the plugin
validates it (unique names/namespaces, acyclic \`depends_on\`, resolvable interface
endpoints, must/should requirements traced, known domains) and ingests it
automatically when \`decomposition_mode\` is \`auto\`, or holds it for the user to
confirm (the default \`confirm\`, presented by the Referee with the question tool).
\`design_decompose\` ingests the manifest (passing \`decomposition_json\`, or omitting
it to read the written file) and creates one **subsystem run** per entry.
Each subsystem is an ordinary run with \`parent_slug\`, a \`namespace\`, its own
budget and namespaced ids; \`pumpChildren\` dispatches ready children in dependency
order. The accepted manifest is persisted as
\`docs/design/<root>/decomposition.json\` for auditability, and a subsystem
inherits the root's budget tier unless the manifest names a \`mode\`. The root's
integration hand-off includes \`subsystem_loose_ends\` (subsystems' unresolved and
accepted findings) so cross-subsystem gaps they left are not missed.

**Manifest rules.** \`version\` must be a positive integer; subsystem \`name\` and
\`namespace\` (an uppercase token, \`^[A-Z][A-Z0-9]*$\`) must be unique; each
requirement id must start with \`<namespace>-R-\`; \`depends_on\` must name sibling
subsystems and be acyclic; every subsystem \`requires\` token must be \`provides\`d
by a sibling and covered by an \`interfaces\` entry; \`domains\` must be known; and
traceability must cover every must/should system requirement. A subsystem
requirement's \`system_reqs\` may cite **only must/should system requirements** — a
could/wont id is rejected even though it exists in the ledger (traceability
entries may reference any system requirement). Cite the must/should requirement a
could/wont item actually serves instead.

**When validation runs.** Readiness is (re)computed when the Architect calls
\`design_respond\` (at the moment a decompose root's own gate goes clean), when
\`design_decompose\` reads the manifest, and on every \`design_status\` read while the
run holds in \`awaiting_decomposition\`. So editing \`decomposition.json\` and calling
\`design_status\` refreshes the reported \`ready\`/\`error\` state — no extra round is
needed to clear a stale error.

The root's \`childrenGate\` (\`pending\` → \`waiting\` → \`ready\`/\`failed\`) accepts only
when required children are \`converged\`/\`accepted_with_reservations\`; a required
child that terminates unaccepted makes the root terminal \`blocked\`. A root
finding carrying \`subsystem_ref\` blocks that child
(\`acceptance_blocked_by_parent\`). The root's Architect cannot edit subsystem documents, so its \`fix\` on a finding with \`subsystem_ref\` keeps it open and gating while the plugin reopens that subsystem with it; it closes when a later root review no longer raises it. Cross-run traceability links system and
subsystem requirements; uncovered must/should system requirements block root
acceptance. An **interface gate** additionally holds root acceptance while a
declared cross-subsystem interface is unsatisfiable or out of order: every
subsystem \`requires\` must be \`provides\`d by a sibling, each \`interfaces\` entry's
\`contract\` must be declared by both endpoints, and a subsystem that is accepted
must not depend on a required producer that is not yet accepted. Declare these in
\`decomposition.json\` (\`provides\`/\`requires\` on each subsystem and \`interfaces\`
entries) so a dependency a system requirement does not name — e.g. one subsystem
handing a typed value to another — is gated instead of silent. Pausing or
stopping a root applies to the whole effort (its subsystems are stopped too), and
a terminal root never restarts a subsystem. A plain run is unchanged.

## Bootstrap and elicitation

1. \`design_start\` creates the run directory and \`00-brief.md\`.
2. Add requirements with \`design_add_requirement\` (stable ids \`R-001\`, priority
   \`must | should | could | wont\`, acceptance criteria). The plugin writes
   \`01-requirements.md\` from the ledger.
3. Record hard constraints and assumptions in \`02-constraints-assumptions.md\`.
4. Present the ledger and ask the user to confirm. Do not dispatch the loop
   until confirmed.
5. \`design_confirm_requirements\` freezes the ledger and moves to \`designing\`.
6. \`design_dispatch\` starts the loop; the Architect first produces revision
   \`v1\`, then round 1 reviews it.

## Severity and categories

- \`blocker\`: design is wrong, unsafe, or violates a must-have requirement.
- \`major\`: significant gap, contradiction, or credible risk scenario.
- \`minor\`: improvement; goes to \`08-open-issues.md\`.
- Categories: \`requirement_gap | contradiction | ambiguity | reliability |
  security | scale | cost | operability | data | evolvability | other\`.

Only validated \`blocker\`/\`major\` findings gate convergence.

## Evidence taxonomy

Every finding carries \`evidence.class\` and \`evidence.verification\`:

- \`executable\` — a command, benchmark, typecheck, or generated scenario.
- \`authoritative\` — a checkable citation.
- \`model_checked\` — a formal model-check or exhaustive case walk.
- \`structured_argument\` — a reasoned scenario with concrete failure conditions.
- \`belief\` — an opinion; visible but never binding.

\`verification\` is one of \`hypothesis | supported | verified | disputed\`.

Record evidence with \`design_record_evidence\` (class, command, output,
exit_code) before citing it, and put the returned id in the finding as
\`evidence.artifact_id\`. An \`executable\` or \`model_checked\` finding without a
recorded artifact is **downgraded to \`hypothesis\`** and will not gate
convergence. Evidence recorded by a dispatched agent is taken from a bash
command that agent actually ran in the current turn: run it with the bash tool,
then call \`design_record_evidence\` with the same \`command\`; the plugin records
the captured output and exit code and ignores typed-in ones. Evidence recorded by
the Referee or user is taken as given. Only \`verified\` strong-class evidence is binding; \`supported\` is
visible but does not gate. A finding with no \`requirement_ids\`/\`constraint_ref\`
or no \`artifact_ref\` is rejected as noise.

## Verdict schema (Falsifier)

\`\`\`json
{
  "round": 1,
  "design_revision": "v1",
  "verdict": "changes_required | accepted_with_reservations | accepted",
  "summary": "one paragraph",
  "findings": [
    {
      "id": "F-001",
      "severity": "blocker | major | minor",
      "category": "requirement_gap | contradiction | ambiguity | reliability | security | scale | cost | operability | data | evolvability | other",
      "claim": "concrete assertion",
      "counterexample": "scenario under which the design fails",
      "evidence": {
        "class": "executable | authoritative | model_checked | structured_argument | belief",
        "artifact_id": "E-001",
        "detail": "command/output/citation/argument",
        "verification": "hypothesis | supported | verified | disputed"
      },
      "requirement_ids": ["R-001"],
      "constraint_ref": "C-003",
      "artifact_ref": "03-architecture.md#section",
      "suggested_direction": "optional",
      "action": "open | needs_adjudication"
    }
  ],
  "coverage": {
    "dimensions": ["requirements", "security", "scale", "cost", "operability", "failure", "data", "evolvability"],
    "examined": ["requirements"],
    "gaps": ["security"]
  },
  "no_new_falsifiable_claim": false
}
\`\`\`

Submit it with \`design_submit_verdict\` (\`verdict_json\`); the plugin persists it
to \`.crucible/verdicts/round-<NN>.json\`. Append a short human summary plus the
findings to \`07-review-log.md\`.

## Response schema (Architect)

\`\`\`json
{
  "round": 1,
  "design_revision": "v2",
  "responses": [
    {
      "finding_id": "F-001",
      "disposition": "fix | rebut | accept_risk | simplify | wont_fix",
      "rationale": "why, referencing the artifact change",
      "artifact_change": "03-architecture.md#section",
      "refutation_evidence": {
        "class": "executable | authoritative | model_checked | structured_argument",
        "verification": "verified",
        "detail": "..."
      }
    }
  ],
  "decisions": [
    { "id": "D-004", "decision": "...", "rationale": "...", "alternatives": ["..."], "supersedes": "D-001" }
  ]
}
\`\`\`

Submit it with \`design_respond\` (\`response_json\`). The initial call (round 0,
revision \`v0\`) produces \`v1\` with no findings.

## Validation ladder (enforced by the plugin)

Findings are classified in this order; the first match wins.

1. Missing requirement/constraint citation or \`artifact_ref\` → \`rejected_noise\`.
2. A category owned by an unowned domain on a domain-scoped run → \`advisory\`
   (visible, does not gate).
3. A \`fix\` disposition → \`resolved\`.
4. A \`rebut\` with verified strong refutation evidence → \`resolved\`; otherwise
   \`needs_adjudication\`. Executable/model_checked refutation evidence must cite a
   recorded artifact (\`refutation_evidence.artifact_id\`, from
   \`design_record_evidence\`), as for findings; \`design_respond\` rejects a
   rebuttal claiming verified executable/model_checked evidence without one.
5. \`accept_risk\` / \`wont_fix\` (justified deliberate non-fix) →
   \`accepted_risk\` when the finding is not a verified (binding) blocker/major;
   on a binding blocker/major → \`needs_adjudication\` (contested): it keeps
   gating and goes to the user, who ratifies it ("Accept the risk") or reopens it.
6. \`simplify\` (addressed by removing or reducing mechanism) → \`resolved\`.
7. \`disputed\`, or \`action: "needs_adjudication"\` → \`needs_adjudication\`
   (a Falsifier-requested ruling stays \`needs_adjudication\` whatever the Architect answers; it gates when verified and a blocker/major. Disputed ones don't gate, see escalations below).
8. Strong class (\`executable\`/\`authoritative\`/\`model_checked\`) **and**
   \`verification: "verified"\` → \`binding\`.
9. Strong class but only \`supported\` → \`supported\` (visible, does not gate).
10. Otherwise → \`plausible\` (visible, does not gate).

Every finding ends as one of these; the plugin never silently drops one.

## Requirement ledger rules

- The ledger is the source of truth but is **amendable**.
- A ruling that changes what a requirement says should be followed by \`design_amend_requirement\`, which bumps the version and keeps the old text in its history.
- The Falsifier may cite existing IDs and may file \`requirement_gap\` findings,
  which escalate to the user. List pending escalations with \`design_escalations\`
  and ratify one with \`design_decide\` (it locates the finding across the effort,
  root or subsystem).
- A blocker/major in \`needs_adjudication\` that is contested, Falsifier-requested
  (\`action: "needs_adjudication"\`), or \`disputed\` is escalated to the user and
  HELD on the board across rounds until the user decides, even if the Falsifier
  does not re-raise it; contested ones keep gating convergence until decided.
  Falsifier-requested rulings are escalated at verdict time, while the Architect
  works. The Architect's answer to one (even \`fix\`) is only a proposal, so it stays
  \`needs_adjudication\` until the user rules; a verified one gates until then. The
  loop does not pause for it, and the Architect may still answer a held finding
  by its id in a later round. User rulings: "Ratify as resolved" accepts the
  Architect's proposal; "Accept the risk" accepts the risk; "Reopen" means the
  finding stands: it becomes an ordinary verified finding that the Architect must
  answer (a \`fix\` then resolves it). A ruling re-scores the last scored round: a run
  that is between rounds, \`budget_stopped\`, or \`no_progress\` only because of that
  finding finishes as \`converged\` / \`accepted_with_reservations\` if it now
  qualifies.
- An escalation is surfaced as a **question dialog**: when one is raised (and
  again after a restart) the plugin prompts the Referee, which MUST call the
  \`question\` tool with per-item choices ("Ratify as resolved" / "Accept the
  risk" / "Reopen" / "Leave for now") and then call \`design_decide\` for the
  chosen action — describing the choices in text is not sufficient. A subsystem
  escalation is raised through its root's session.
- The ledger is frozen only after explicit user confirmation; later amendments
  bump \`version\`.

## Decision ledger rules

- Record decisions with \`design_record_decision\` (or a \`decisions\` array in the
  response). Extra ids (\`D-###\`) are assigned automatically.
- Recording with an id that already exists updates that entry in place (idempotent
  by id), so a decision may be amended after it was first recorded.
- To reverse a settled decision, record a new one with \`supersedes\` set to the
  target id: the target is marked \`superseded\` and each decision records
  \`supersede_count\`. This may be done from \`design_record_decision\` or from a
  \`decisions\` array in \`design_respond\`, and after the fact (you need not have
  named the target when the replacement was first written) — for example, to make
  a new \`D-025\` formally supersede an earlier \`D-015\`.
- More than 2 supersedes on one decision sets an escalation for the user.

## Coverage-over-testability

The plugin maintains a coverage matrix across the dimensions in the verdict
schema, counting those examined in the last \`k\` rounds (since integration began,
for decompose roots), not ever. The Falsifier lists in \`coverage.examined\` what
it examined this round. Convergence requires a complete matrix regardless of which dimensions
are easy to test. Argument-class findings stay visible even when they cannot be
verified.

## Convergence and budgets

Converged when all hold:

- zero binding blockers;
- binding majors ≤ \`majors_threshold\` (default 0);
- no new validated blocker/major in the last \`k\` rounds (default 2; verified findings put to the user count);
- coverage matrix complete;
- the design is within the spec-size budget (\`max_spec_lines\`, per mode);
- the Falsifier self-certifies \`no_new_falsifiable_claim\` for the round.

**Minimality.** The Architect prefers the smallest change, reuses existing code
and decisions, and must not add mechanism no requirement demands; a finding that
asks for disproportionate complexity should be \`simplify\`d or \`wont_fix\`ed
rather than satisfied with more machinery. The Falsifier must weigh a finding's
value against the complexity of fixing it, and the spec-size budget
(\`fast\` 400, \`standard\` 1500, \`deep\` 4000 lines over \`00\`–\`06\`) gates
convergence — an over-budget design cannot converge or be accepted, so the loop
must shrink it.

\`accepted_with_reservations\` when nothing gates (zero binding blockers, majors
within threshold, coverage complete) and the critic has settled to one new
validated finding per round for \`k\` consecutive rounds (diminishing returns), or
when the board is clean at the round budget. This is the healthy adversarial
case: the Architect resolves every finding, yet the Falsifier keeps finding one
more. It is a distinct, honest terminal rather than a false \`converged\`.
Requiring the count to settle at one (rather than merely "at most one", which a
zero-finding round would also satisfy) avoids accepting during early
exploration, and leaves a run that has gone quiet to converge instead. A run also ends \`accepted_with_reservations\` when the last \`k\` rounds found only minors (no blocker or major findings), and those minors become the reservations; quiet rounds with no findings still wait for the Falsifier's self-certification.

**Verification pass.** When an acceptance (\`converged\` or \`accepted_with_reservations\`), or a decompose root's entry into \`awaiting_decomposition\`, would rest on blocker/major findings that the Architect closed in that same round with \`fix\` or \`simplify\`, the plugin first runs one more Falsifier round (even past the round budget) to check those fixes. The dispatch lists them. The Falsifier re-raises any fix that does not hold, by its same id with evidence recorded this round. If no binding blocker/major remains after that verdict, the acceptance stands (or the decomposition hold opens) without another Architect turn. Otherwise the run continues as a normal round if it is within budget, or ends \`budget_stopped\` (\`stop_reason: fix_not_verified\`).

Budget tiers (\`mode\`), all using one reused child session per role:

- \`fast\` (default): max 3 rounds.
- \`standard\`: max 8 rounds.
- \`deep\`: max 15 rounds.

Terminal states: \`converged\`; \`accepted_with_reservations\`; \`budget_stopped\`
(best revision plus residual findings and an explicit "not fully converged"
status); \`no_progress\` (the gating findings raised in each round that the Architect left
**unresolved** did not decrease over \`m=2\` rounds; findings held over for the
user do not count); \`stopped\` (user). On
terminal the plugin writes \`08-open-issues.md\` (its "Accepted risks" lists accepted
risks from every round, and who accepted them), updates the session title, and
raises a toast.

\`design_resume\` reopens any terminal run at the phase it stopped from (user
stops record \`stopped_from\`; other terminals continue into a fresh round).

## Hard rules

- A dispatched agent may call only its own role's tools on its own run; the
  Referee owns rounds, dispatch, decomposition, adjudication, lifecycle, and
  configuration. Agents never write \`.crucible/\` state, the Falsifier writes only
  \`07-review-log.md\`, and the Architect never edits the brief, requirements,
  review log, or open issues.
- Dispatched agents (the Architect and Falsifier) write files only inside their own run directory (the working directory in their dispatch); scratch files may go under opencode's temp directory (e.g. /tmp/opencode). The plugin refuses edits anywhere else in the project.
- Dispatched agents may use only read-only git (status, log, diff, show, blame, grep); the plugin refuses any command that changes the repository.
- The Referee never fabricates agent output; it reads the actual tools and
  files.
- The Falsifier never edits design artifacts; the Architect never edits the
  review log, verdicts, or state.
- Every finding cites a requirement id or constraint and an artifact section;
  uncited findings are rejected as noise.
- New findings are numbered from \`next_finding_id\` in the hand-off
  (\`design_get_context\`). Keeping an old id means re-raising that same finding;
  the plugin rejects a verdict that reuses the id of a resolved finding unless it
  cites evidence recorded this round.
- The loop must be stoppable by the user at any time.
`
