import { createHash } from "node:crypto"
import * as path from "node:path"

// Crucible core: pure state, validation, and convergence logic (no opencode imports, no I/O).

export const SCHEMA_VERSION = 5

export const STRONG_EVIDENCE = new Set(["executable", "authoritative", "model_checked"])
export const EVIDENCE_CLASSES = new Set([...STRONG_EVIDENCE, "structured_argument", "belief"])
export const VERIFICATIONS = new Set(["hypothesis", "supported", "verified", "disputed"])
export const SEVERITIES = new Set(["blocker", "major", "minor"])
export const CATEGORIES = new Set([
  "requirement_gap",
  "contradiction",
  "ambiguity",
  "reliability",
  "security",
  "scale",
  "cost",
  "operability",
  "data",
  "evolvability",
  "other",
])
export const DISPOSITIONS = new Set(["fix", "rebut", "accept_risk", "simplify", "wont_fix"])
export const PRIORITIES = new Set(["must", "should", "could", "wont"])
export const PRESETS = ["fast", "standard", "deep", "exhaustive"]
export const REQUIRED_DIMENSIONS = ["requirements", "security", "scale", "cost", "operability", "failure", "data", "evolvability"]
export const GATE_SEVERITIES = new Set(["blocker", "major"])
export const TERMINAL = new Set(["converged", "accepted_with_reservations", "budget_stopped", "no_progress", "stopped", "blocked"])
export const ACCEPTED_TERMINAL = new Set(["converged", "accepted_with_reservations"])

export function isAcceptedTerminal(phase: string) {
  return ACCEPTED_TERMINAL.has(phase)
}

// Commands refused in Crucible child sessions (provenance guard, not a sandbox).
export const DESTRUCTIVE = [
  /\brm\s+(-{1,2}[a-z-]*\s+)*\//i, // rm -rf /, rm --no-preserve-root /...
  /\brm\s+(-{1,2}[a-z-]*\s+)*\*/i, // rm -rf *
  /\brm\s+(-{1,2}[a-z-]*\s+)*["']?(~|\$HOME|\$\{HOME\})/i, // rm -rf ~ / $HOME / "$HOME"
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bchown\s+-R\s+[^\s]+\s+\//i,
  /curl[^|]*\|\s*(ba)?sh/i,
  /wget[^|]*\|\s*(ba)?sh/i,
  /\bfind\b[^\n]*-delete\b/i,
  /\btruncate\b[^\n]*-s\s*0\b/i,
  /\brm\s+(-{1,2}[a-z-]*\s+)*["']?\.\.?\/?["']?(\s|$)/i, // rm -rf . / ./ / .. / ../
  /\bwipefs\b/i,
  /:\(\)\s*\{.*\};:/,
]

// The only git a design agent may run: read-only, so it never touches the user's index, branches, worktree or history.
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file", "describe", "shortlog", "version", "help"])
// Each git invocation's subcommand, past global options such as -C <dir> or -c key=value.
const GIT_CALL = /\bgit((?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+([\w-]+)/g

export function changesGit(command: string) {
  for (const m of String(command || "").matchAll(GIT_CALL)) if (!READ_ONLY_GIT.has(m[2])) return true
  return false
}

export function isDestructive(command: string) {
  const cmd = String(command || "")
  return DESTRUCTIVE.some((re) => re.test(cmd)) || changesGit(cmd)
}

// True when candidate is base or a descendant of it (path-containment guard).
export function withinDir(candidate: string, base: string) {
  const c = path.resolve(String(candidate || ""))
  const b = path.resolve(String(base || ""))
  if (c === b) return true
  // A filesystem root already ends in a separator.
  if (b === path.parse(b).root) return c.startsWith(b)
  return c.startsWith(b + path.sep)
}

export function nowIso() {
  return new Date().toISOString()
}

export function slugify(input: string) {
  const trim = (v: string) => v.replace(/^-+|-+$/g, "")
  // Trim again after truncation so a cut never leaves a trailing dash.
  const s = trim(trim(String(input || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 60))
  return s || "design"
}

// A stored run slug: well-formed slugs (incl. subsystem '--') verbatim, else slugified.
export const SLUG_RE = /^[a-z0-9]+(?:-+[a-z0-9]+)*$/
export function normalizeSlug(input: any) {
  const v = String(input ?? "").trim()
  return SLUG_RE.test(v) ? v : slugify(v)
}

export function budgetsFor(mode?: string) {
  if (mode === "deep") return { mode: "deep", max_rounds: 15, k: 2, m: 2, majors_threshold: 0, max_spec_lines: 4000 }
  if (mode === "standard") return { mode: "standard", max_rounds: 8, k: 2, m: 2, majors_threshold: 0, max_spec_lines: 1500 }
  return { mode: "fast", max_rounds: 3, k: 2, m: 2, majors_threshold: 0, max_spec_lines: 400 }
}

// Named effort presets for a run's budgets.
export function presetBudgets(preset?: string) {
  if (preset === "exhaustive") return { mode: "exhaustive", max_rounds: 40, k: 3, m: 3, majors_threshold: 0, max_spec_lines: 8000 }
  return budgetsFor(preset)
}

export function nextRevision(rev: string) {
  const m = /^v(\d+)$/.exec(rev || "")
  return m ? `v${Number(m[1]) + 1}` : "v1"
}

export function evidenceClassOk(finding: any) {
  return !!finding && STRONG_EVIDENCE.has(finding?.evidence?.class)
}

export function isBindingEvidence(finding: any) {
  return evidenceClassOk(finding) && finding?.evidence?.verification === "verified"
}

export function isSupportedEvidence(finding: any) {
  return evidenceClassOk(finding) && finding?.evidence?.verification === "supported"
}

export function isCited(finding: any) {
  return (Array.isArray(finding?.requirement_ids) && finding.requirement_ids.length > 0) || !!finding?.constraint_ref
}

// A finding that holds the gate: validated binding evidence, or contested pending adjudication.
export function isGating(f: any) {
  if (!GATE_SEVERITIES.has(f?.severity)) return false
  return f.status === "binding" || (f.status === "needs_adjudication" && f.contested === true)
}

// A blocker/major that waits on the user's ruling: escalated, and held on the board until decided.
export function awaitsUser(f: any) {
  if (f?.status !== "needs_adjudication" || !GATE_SEVERITIES.has(f.severity)) return false
  return f.contested === true || f.action === "needs_adjudication" || f.verification === "disputed"
}

export function adjudicationWhy(f: any) {
  const gates = f?.contested ? "; it gates until you decide" : ""
  if (f?.action === "needs_adjudication") return `the Falsifier asks for your ruling${gates}`
  if (f?.contested && (f.disposition === "accept_risk" || f.disposition === "wont_fix")) return `the Architect proposes ${f.disposition} on a verified ${f.severity}${gates}`
  if (f?.contested) return `rebutted without verified evidence${gates}`
  if (f?.verification === "disputed") return "its evidence is disputed"
  return "rebutted without verified evidence"
}

// Why an executable/model_checked claim lacks a recorded strong artifact (null when backed or not required).
export function unbackedReason(state: any, ev: any): string | null {
  if (ev?.class !== "executable" && ev?.class !== "model_checked") return null
  const aid = ev?.artifact_id
  const rec = aid ? (state?.evidence || []).find((e: any) => e.id === aid) : null
  if (!rec) return `no recorded evidence artifact${aid ? ` for ${aid}` : ""}`
  if (!STRONG_EVIDENCE.has(rec.class)) return `${aid} is a ${rec.class || "unclassified"} record, not executable/model-checked evidence`
  return null
}

// --- scale model (decomposition, children, traceability, domains) ----------

// Which coverage dimension owns which finding category.
export const DIMENSION_CATEGORIES: Record<string, string[]> = {
  requirements: ["requirement_gap"],
  security: ["security"],
  scale: ["scale"],
  cost: ["cost"],
  operability: ["operability"],
  failure: ["reliability"],
  data: ["data"],
  evolvability: ["evolvability"],
}
export const DOMAIN_CATEGORIES = new Set(Object.values(DIMENSION_CATEGORIES).flat())

export function categoryInScope(state: any, category: string) {
  if (!state?.domains || state.domains.length === 0) return true
  if (!DOMAIN_CATEGORIES.has(category)) return true
  return state.domains.some((d: string) => (DIMENSION_CATEGORIES[d] || []).includes(category))
}

export function requiredDimensions(state: any) {
  return Array.isArray(state?.domains) && state.domains.length ? state.domains : REQUIRED_DIMENSIONS
}

export function coverageGaps(state: any) {
  const required = requiredDimensions(state)
  const examined = new Set(state?.coverage?.examined || [])
  return required.filter((d: string) => !examined.has(d))
}

// Recompute the coverage matrix against the run's (possibly changed) domains.
export function refreshCoverage(state: any) {
  state.coverage = state.coverage || {}
  state.coverage.examined = Array.from(new Set<string>(state.coverage.examined || []))
  state.coverage.required = [...requiredDimensions(state)]
  state.coverage.gaps = coverageGaps(state)
}

// Root acceptance gate over its declared required subsystems.
function childNameOf(child: any) {
  if (child?.name) return child.name
  const slug = String(child?.slug || "")
  const idx = slug.lastIndexOf("--")
  return idx >= 0 ? slug.slice(idx + 2) : slug
}

function listOf(v: any): any[] {
  return Array.isArray(v) ? v : []
}

// contract -> names of the subsystems that provide it.
function providersByContract(subs: any[]) {
  const out = new Map<string, string[]>()
  for (const s of subs) {
    for (const p of listOf(s?.provides)) {
      const key = String(p)
      out.set(key, [...(out.get(key) || []), String(s.name)])
    }
  }
  return out
}

// The subsystems root acceptance actually needs: declared-required plus transitive deps and sole providers.
export function effectiveRequired(state: any): Set<string> {
  const subs = listOf(state?.subsystems)
  const byName = new Map<string, any>()
  for (const s of subs) if (s?.name && !byName.has(s.name)) byName.set(s.name, s)
  const providers = providersByContract(subs)
  const out = new Set<string>()
  const stack: string[] = subs.filter((s: any) => s?.name && s.required !== false).map((s: any) => s.name)
  while (stack.length) {
    const name = stack.pop() as string
    if (out.has(name) || !byName.has(name)) continue
    out.add(name)
    const s = byName.get(name)
    for (const d of listOf(s.depends_on)) stack.push(String(d))
    for (const r of listOf(s.requires)) {
      const ps = providers.get(String(r)) || []
      if (ps.length === 1) stack.push(ps[0])
    }
  }
  return out
}

export function childrenGate(state: any) {
  if (!state?.decompose || state.parent_slug) return "ready"
  const declared = listOf(state.subsystems)
  if (declared.length === 0) return "pending"
  const phaseByName = new Map<string, string>()
  for (const c of listOf(state.children)) phaseByName.set(childNameOf(c), c?.phase)
  const required = [...effectiveRequired(state)]
  if (required.length === 0) return "ready"
  const byName = new Map<string, any>()
  for (const s of declared) if (s?.name && !byName.has(s.name)) byName.set(s.name, s)
  const providers = providersByContract(declared)
  const failed = (name: string) => {
    if (!phaseByName.has(name)) return true
    const phase = phaseByName.get(name) || ""
    return TERMINAL.has(phase) && !isAcceptedTerminal(phase)
  }
  const accepted = (name: string) => isAcceptedTerminal(phaseByName.get(name) || "")
  // A required consumer of a contract with several providers needs any one.
  const anyOf = required.flatMap((n) =>
    listOf(byName.get(n)?.requires)
      .map((r: any) => providers.get(String(r)) || [])
      .filter((ps: string[]) => ps.length > 1),
  )
  if (required.some(failed) || anyOf.some((ps) => ps.every(failed))) return "failed"
  if (required.some((n) => !accepted(n)) || anyOf.some((ps) => !ps.some(accepted))) return "waiting"
  return "ready"
}

// Uncovered must/should system requirements. Applies only to a decomposed root.
export function traceabilityGaps(state: any) {
  if (!state?.decompose || state.parent_slug) return []
  if (!Array.isArray(state.subsystems) || state.subsystems.length === 0) return []
  const items = (state.requirements?.items || []).filter((r: any) => r.priority === "must" || r.priority === "should")
  const covered = new Set<string>()
  for (const t of state.traceability || []) {
    if (Array.isArray(t.subsystem_reqs) && t.subsystem_reqs.length) covered.add(t.system_req)
  }
  return items.map((r: any) => r.id).filter((id: string) => !covered.has(id))
}

// Cross-run interface gate: a root cannot accept while a declared interface is unsatisfiable or out of order.
export function interfaceGapDetails(state: any): Array<{ gap: string; settled: boolean }> {
  if (!state?.decompose || state.parent_slug) return []
  const subs = listOf(state.subsystems)
  if (subs.length === 0) return []
  const phaseByName = new Map<string, string>()
  for (const c of listOf(state.children)) phaseByName.set(childNameOf(c), c.phase)
  const byName = new Map<string, any>()
  for (const s of subs) if (s?.name) byName.set(s.name, s)
  const providedBy = providersByContract(subs)
  const accepts = (name: string) => isAcceptedTerminal(phaseByName.get(name) || "")
  const dead = (name: string) => {
    const phase = phaseByName.get(name)
    return !phase || (TERMINAL.has(phase) && !isAcceptedTerminal(phase))
  }
  const gaps: Array<{ gap: string; settled: boolean }> = []
  // 1. Every requires must be provided by some declared subsystem.
  for (const s of subs) {
    for (const r of listOf(s.requires)) {
      if (!providedBy.has(String(r))) gaps.push({ gap: `${s.name} requires '${r}' which no subsystem provides`, settled: true })
    }
  }
  // 2. Every declared interface endpoint must actually declare the contract.
  for (const i of listOf(state.interfaces)) {
    const from = byName.get(i?.from)
    const to = byName.get(i?.to)
    if (!from || !to) {
      gaps.push({ gap: `interface ${i?.from} -> ${i?.to} names an unknown subsystem`, settled: true })
      continue
    }
    if (i?.contract && !listOf(from.provides).map(String).includes(String(i.contract))) {
      gaps.push({ gap: `${i.from} does not provide interface contract '${i.contract}'`, settled: true })
    }
    if (i?.contract && !listOf(to.requires).map(String).includes(String(i.contract))) {
      gaps.push({ gap: `${i.to} does not require interface contract '${i.contract}'`, settled: true })
    }
  }
  // 3. An accepted consumer needs an accepted provider of every contract it requires.
  for (const s of subs) {
    if (!accepts(s.name)) continue
    for (const r of listOf(s.requires)) {
      const providers = providedBy.get(String(r)) || []
      if (providers.length && !providers.some(accepts)) {
        gaps.push({
          gap: `${s.name} is accepted but no provider of '${r}' (${providers.join(", ")}) is accepted`,
          settled: providers.every(dead),
        })
      }
    }
  }
  return gaps
}

export function interfaceGaps(state: any): string[] {
  return interfaceGapDetails(state).map((g) => g.gap)
}

// Pure structural validation of a decomposition manifest.
export function manifestProblems(manifest: any, systemReqs: string[], allReqs: string[] = systemReqs) {
  const problems: string[] = []
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest is not an object"]
  const version = Number(manifest.version)
  if (!Number.isInteger(version) || version < 1) problems.push("manifest.version must be a positive integer")
  if (manifest.max_parallel != null && !(Number.isInteger(Number(manifest.max_parallel)) && Number(manifest.max_parallel) > 0)) {
    problems.push("manifest.max_parallel must be a positive integer")
  }
  // Validate shape defensively: a malformed manifest must report problems, not throw.
  const asArray = (v: any, label: string): any[] => {
    if (v == null) return []
    if (!Array.isArray(v)) {
      problems.push(`${label} must be an array`)
      return []
    }
    return v
  }
  const subs: any[] = asArray(manifest.subsystems, "subsystems")
  if (subs.length === 0) problems.push("no subsystems")
  const knownReqs = new Set<string>(systemReqs)
  const ledgerReqs = new Set<string>(allReqs)
  const names = new Set<string>()
  const namespaces = new Set<string>()
  // Two names that slugify alike would share one child run directory.
  const slugOwner = new Map<string, string>()
  const subReqIds = new Set<string>()
  for (const s of subs) {
    if (!s?.name || !String(s.name).trim()) problems.push("a subsystem has no name")
    else if (names.has(s.name)) problems.push(`duplicate subsystem name '${s.name}'`)
    else {
      const slug = slugify(String(s.name))
      const owner = slugOwner.get(slug)
      if (owner !== undefined) problems.push(`subsystem names '${owner}' and '${s.name}' map to the same run slug '${slug}'`)
      else slugOwner.set(slug, String(s.name))
    }
    if (s?.name) names.add(s.name)
    if (!s?.namespace || !/^[A-Z][A-Z0-9]*$/.test(String(s.namespace))) problems.push(`subsystem '${s?.name}' namespace must be an uppercase token`)
    else if (namespaces.has(s.namespace)) problems.push(`duplicate namespace '${s.namespace}'`)
    if (s?.namespace) namespaces.add(s.namespace)
    if (s?.mode != null && !PRESETS.includes(String(s.mode))) problems.push(`subsystem '${s?.name}' has unknown mode '${s.mode}' (${PRESETS.join("|")})`)
    const dims = new Set<string>(REQUIRED_DIMENSIONS)
    for (const d of asArray(s?.domains, `subsystem '${s?.name}' domains`)) {
      if (!dims.has(String(d))) problems.push(`subsystem '${s?.name}' has unknown domain '${d}'`)
    }
    const ownIds = new Set<string>()
    for (const r of asArray(s?.requirements, `subsystem '${s?.name}' requirements`)) {
      const rid = String(r?.id || "")
      if (!rid.startsWith(`${s?.namespace}-R-`)) problems.push(`requirement id '${r?.id}' must start with '${s?.namespace}-R-'`)
      if (rid && ownIds.has(rid)) problems.push(`subsystem '${s?.name}' has duplicate requirement id '${rid}'`)
      if (rid) {
        ownIds.add(rid)
        subReqIds.add(rid)
      }
      if (r?.priority != null && !PRIORITIES.has(String(r.priority))) problems.push(`requirement '${r?.id}' has unknown priority '${r.priority}' (must|should|could|wont)`)
      for (const sr of asArray(r?.system_reqs, `requirement '${r?.id}' system_reqs`)) {
        if (!knownReqs.has(String(sr))) {
          if (ledgerReqs.has(String(sr)))
            problems.push(`requirement '${r?.id}' references '${sr}', which is a could/wont requirement; system_reqs may cite only must/should system requirements`)
          else problems.push(`requirement '${r?.id}' references unknown system requirement '${sr}'`)
        }
      }
    }
    for (const dep of asArray(s?.depends_on, `subsystem '${s?.name}' depends_on`)) {
      if (!subs.some((x: any) => x?.name === dep)) problems.push(`subsystem '${s?.name}' depends_on unknown '${dep}'`)
    }
  }
  const byName = new Map<string, any>()
  for (const s of subs) if (s?.name && !byName.has(s.name)) byName.set(s.name, s)
  const visiting = new Set<string>()
  const done = new Set<string>()
  // Shape errors were already reported above; the cycle walk reads silently.
  const visit = (name: string): boolean => {
    if (done.has(name)) return true
    if (visiting.has(name)) return false
    visiting.add(name)
    for (const dep of listOf(byName.get(name)?.depends_on)) if (!visit(dep)) return false
    visiting.delete(name)
    done.add(name)
    return true
  }
  for (const s of subs) {
    if (s?.name && !visit(s.name)) {
      problems.push("depends_on contains a cycle")
      break
    }
  }
  const interfaces = asArray(manifest.interfaces, "interfaces")
  for (const i of interfaces) {
    if (!names.has(i?.from)) problems.push(`interface from unknown '${i?.from}'`)
    if (!names.has(i?.to)) problems.push(`interface to unknown '${i?.to}'`)
    if (i?.contract && byName.has(i?.from) && !listOf(byName.get(i.from).provides).map(String).includes(String(i.contract))) {
      problems.push(`interface ${i.from} -> ${i?.to}: '${i.from}' does not provide contract '${i.contract}'`)
    }
    if (i?.contract && byName.has(i?.to) && !listOf(byName.get(i.to).requires).map(String).includes(String(i.contract))) {
      problems.push(`interface ${i?.from} -> ${i.to}: '${i.to}' does not require contract '${i.contract}'`)
    }
  }
  // Every requires entry must be provided by a subsystem and declared by an interface.
  const provided = new Set<string>()
  for (const s of subs) for (const p of asArray(s?.provides, `subsystem '${s?.name}' provides`)) provided.add(String(p))
  for (const s of subs) {
    for (const r of asArray(s?.requires, `subsystem '${s?.name}' requires`)) {
      if (!r) continue
      if (!provided.has(String(r))) problems.push(`subsystem '${s?.name}' requires '${r}' which no subsystem provides`)
      else if (!interfaces.some((i: any) => i?.to === s?.name && String(i?.contract) === String(r))) {
        problems.push(`subsystem '${s?.name}' requires '${r}' but no interfaces entry declares it (add {"from": <provider>, "to": "${s?.name}", "contract": "${r}"})`)
      }
    }
  }
  const covered = new Set<string>()
  for (const t of asArray(manifest.traceability, "traceability")) {
    if (t?.system_req != null && !ledgerReqs.has(String(t.system_req))) problems.push(`traceability references unknown system requirement '${t.system_req}'`)
    const subReqs = listOf(t?.subsystem_reqs)
    for (const id of subReqs) {
      if (!subReqIds.has(String(id))) problems.push(`traceability for '${t?.system_req}' references unknown subsystem requirement '${id}'`)
    }
    if (subReqs.some((id: any) => subReqIds.has(String(id)))) covered.add(t.system_req)
  }
  for (const id of systemReqs) if (!covered.has(id)) problems.push(`system requirement '${id}' is not covered by traceability`)
  return problems
}

// Whether a finding's subsystem_ref names this subsystem (name, namespace, or slug).
export function subsystemMatches(sub: any, ref: any) {
  const r = String(ref ?? "").trim()
  if (!r || !sub) return false
  return r === sub.name || r === sub.namespace || r === sub.slug || slugify(r) === slugify(String(sub.name || ""))
}

// Gating root findings that target a subsystem, read from classified open findings.
export function subsystemBlocks(state: any) {
  return (state?.open_findings || [])
    .filter((f: any) => isGating(f) && f.subsystem_ref)
    .map((f: any) => ({ name: f.subsystem_ref, finding_id: f.id }))
}

export function newState(slug: string, system: string, sessionID: string | undefined, mode?: string): any {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: `${slug}-${Date.now()}`,
    slug,
    system,
    session_id: sessionID || null,
    phase: "eliciting",
    round: 0,
    design_revision: "v0",
    spec_lines: 0,
    paused: false,
    dispatch_error_count: 0,
    budgets: presetBudgets(mode),
    requirements: { version: 1, frozen: false, items: [] as any[] },
    decisions: [] as any[],
    evidence: [] as any[],
    open_findings: [] as any[],
    verdicts: {} as Record<string, any>,
    responses: {} as Record<string, any>,
    history: [] as any[],
    coverage: { required: [...REQUIRED_DIMENSIONS], examined: [] as string[], gaps: [...REQUIRED_DIMENSIONS] },
    residual: [] as string[],
    escalation: null as any,
    escalations: [] as any[],
    // Accepted risks of every round (open_findings holds only the latest round's).
    risks: [] as any[],
    // finding id -> { decision, round }: a user adjudication for that round only.
    adjudications: {} as Record<string, any>,
    rounds_without_new_gate: 0,
    gate_stall_streak: 0,
    stall_count: 0,
    dispatch: null as any,
    sessions: {} as Record<string, string>,
    managed_sessions: [] as string[],
    // Scale model (all optional; defaults preserve plain runs):
    decompose: false,
    parent_slug: null,
    subsystems: [] as any[],
    namespace: null,
    traceability: [] as any[],
    interfaces: [] as any[],
    interface_blocked: false,
    interface_gaps: [] as string[],
    domains: [] as string[],
    watchdog_ms: null as number | null,
    waiting_on: [] as string[],
    children: [] as any[],
    effort: slug,
    acceptance_blocked_by_parent: null,
    parent_blocks: [] as string[],
    parent_block_findings: [] as any[],
    parent_block_round: null as number | null,
    parent_reject_count: 0,
    traceability_blocked: false,
    decomposition_version: null,
    decomposition_mode: "confirm",
    decomposition_ready: false,
    decomposition_error: null,
    // Integration rounds get their own budget and convergence evidence from here.
    integration_base_round: null as number | null,
    max_parallel: null,
    // Per-run configuration (chosen at design_start):
    preset: null,
    models: {} as Record<string, string>,
    shellPolicy: null,
    allowAccepted: true,
    notes: "",
    escalation_notified: false,
    spec_over_notified: false,
    paused_reason: null,
    stopped_from: null,
    stop_reason: null,
    // A pending verification pass: { target phase, fixed finding ids, round of the fixes }.
    verify: null as any,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

export function nextId(state: any, prefix: string, collection: any[]) {
  let n = collection.length + 1
  const ids = new Set(collection.map((x: any) => x.id))
  while (ids.has(`${prefix}${String(n).padStart(3, "0")}`)) n += 1
  return `${prefix}${String(n).padStart(3, "0")}`
}

// Escalations are a set keyed by requirement_id; state.escalation mirrors the primary pending one.
function syncEscalationMirror(state: any) {
  const escs: any[] = state.escalations || []
  state.escalation = escs.find((x: any) => x?.status === "pending_user_ratification") || escs[0] || null
}

export function addEscalation(state: any, e: any) {
  if (!e?.requirement_id) return
  state.escalations = state.escalations || []
  const existing = state.escalations.find((x: any) => x.requirement_id === e.requirement_id)
  if (existing) {
    // Only a material change re-arms the notification.
    const changed = existing.reason !== e.reason || (!!e.status && existing.status !== e.status)
    Object.assign(existing, e)
    if (changed && existing.status === "acknowledged") existing.status = "pending_user_ratification"
    existing.notified = changed ? false : existing.notified === true
  } else {
    state.escalations.push({ status: "pending_user_ratification", notified: false, ...e })
  }
  syncEscalationMirror(state)
}

export function removeEscalation(state: any, requirementId: string) {
  state.escalations = (state.escalations || []).filter((x: any) => x.requirement_id !== requirementId)
  syncEscalationMirror(state)
}

// A non-finding escalation the user acknowledged: on record, no longer pending.
export function acknowledgeEscalation(state: any, requirementId: string) {
  const e = (state.escalations || []).find((x: any) => x.requirement_id === requirementId)
  if (!e) return false
  e.status = "acknowledged"
  e.notified = true
  syncEscalationMirror(state)
  return true
}

// Finding-linked escalations are tagged by kind (older states: an `F-` id).
export function isFindingEscalation(e: any) {
  return e?.kind === "finding" || /^F-/.test(String(e?.requirement_id ?? ""))
}

// Withdraw a finding-linked escalation whose finding is gone or renumbered (stale).
export function withdrawStaleEscalations(state: any) {
  const byId = new Map<string, any>((state.open_findings || []).map((f: any) => [f.id, f]))
  for (const e of [...(state.escalations || [])]) {
    if (!isFindingEscalation(e)) continue
    const f = byId.get(e.requirement_id)
    const otherRound = f && e.round != null && f.round != null && e.round !== f.round
    if (!f || otherRound || f.status === "resolved" || f.status === "accepted_risk") removeEscalation(state, e.requirement_id)
  }
}

export function upsertDecisions(state: any, items: any[]) {
  for (const d of items || []) {
    if (!d || !d.decision) continue
    // Assign the id first so supersede links are never written with a missing id.
    if (!d.id) d.id = nextId(state, "D-", state.decisions)
    const existing = state.decisions.find((x: any) => x.id === d.id)
    if (d.supersedes && d.supersedes !== d.id) {
      const prev = state.decisions.find((x: any) => x.id === d.supersedes)
      // A (replacement, target) link counts once, so re-recording is idempotent.
      const linked = new Set<string>([...(prev?.superseders || []), ...(prev?.superseded_by ? [prev.superseded_by] : [])])
      if (prev && !linked.has(d.id)) {
        prev.superseders = [...(prev.superseders || []), d.id]
        prev.supersede_count = (prev.supersede_count || 0) + 1
        prev.status = "superseded"
        prev.superseded_by = d.id
        if (prev.supersede_count > 2) {
          addEscalation(state, { requirement_id: prev.id, kind: "decision", reason: `decision ${prev.id} superseded ${prev.supersede_count} times` })
        }
      }
    }
    // An amendment updates only the fields it names.
    const fields: any = {}
    for (const [key, value] of Object.entries(d)) if (value !== undefined && !(key === "supersedes" && value === d.id)) fields[key] = value
    if (existing) Object.assign(existing, fields)
    else
      state.decisions.push({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale || "",
        alternatives: d.alternatives || [],
        status: d.status || "accepted",
        ...(fields.supersedes ? { supersedes: fields.supersedes } : {}),
        supersede_count: 0,
        round: state.round,
        at: nowIso(),
      })
  }
}

export function digest(text: string) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16)
}

// A finding's action is its declared intent; supersedes happen only via the decision ledger.
export const FINDING_ACTIONS = new Set(["open", "needs_adjudication"])

// Downgrade executable/model_checked claims with no strong recorded artifact to hypotheses.
export function downgradeUnbackedEvidence(state: any, verdict: any) {
  for (const f of verdict?.findings || []) {
    const why = unbackedReason(state, f?.evidence)
    if (!why) continue
    f.evidence.verification = "hypothesis"
    f.evidence.note = `downgraded: ${why}`
  }
  return verdict
}

// The next unused F-### id across every round (new findings never reuse an old id).
export function nextFindingId(state: any) {
  let max = 0
  const all = [...Object.values(state?.verdicts || {}).flatMap((v: any) => v?.findings || []), ...(state?.open_findings || [])]
  for (const f of all) {
    const m = /^F-(\d+)$/.exec(String(f?.id || ""))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `F-${String(max + 1).padStart(3, "0")}`
}

// Structural checks on a submitted verdict (returned so the Falsifier can fix all at once).
export function verdictProblems(state: any, verdict: any): string[] {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return ["verdict must be a JSON object"]
  if (!Array.isArray(verdict.findings)) return ["verdict.findings must be an array"]
  const problems: string[] = []
  if (verdict.round != null && Number(verdict.round) !== state.round) {
    problems.push(`verdict.round ${verdict.round} does not match the current round ${state.round}`)
  }
  if (verdict.design_revision != null && String(verdict.design_revision) !== String(state.design_revision)) {
    problems.push(`verdict.design_revision '${verdict.design_revision}' does not match the revision under review '${state.design_revision}'`)
  }
  if (verdict.coverage?.examined != null && !Array.isArray(verdict.coverage.examined)) problems.push("verdict.coverage.examined must be an array")
  const resolvedIn = new Map<string, number>()
  for (const h of state?.history || []) for (const id of h.resolved_ids || []) if (!resolvedIn.has(id)) resolvedIn.set(id, h.round)
  // A user ruling not yet scored into history still marks its finding resolved.
  for (const f of state?.open_findings || []) if (f.status === "resolved" && f.round < state.round && !resolvedIn.has(f.id)) resolvedIn.set(f.id, f.round)
  const seen = new Set<string>()
  verdict.findings.forEach((f: any, i: number) => {
    const label = f?.id ? `finding '${f.id}'` : `finding #${i + 1}`
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      problems.push(`${label} is not an object`)
      return
    }
    const id = typeof f.id === "string" ? f.id.trim() : ""
    if (!id) problems.push(`${label} has no id`)
    else if (seen.has(id)) problems.push(`duplicate finding id '${id}'`)
    else seen.add(id)
    // An id is the finding's identity: reusing a resolved one would read a new issue as a regression.
    if (resolvedIn.has(id) && !freshEvidenceFor(state, f, state.round)) {
      problems.push(
        `${label} reuses the id of a finding resolved in round ${resolvedIn.get(id)}: number a new finding from ${nextFindingId(state)}; ` +
          `to re-raise the resolved one, cite evidence recorded this round (design_record_evidence) as evidence.artifact_id`,
      )
    }
    if (!SEVERITIES.has(f.severity)) problems.push(`${label} has invalid severity '${f.severity}' (blocker|major|minor)`)
    if (f.category != null && !CATEGORIES.has(f.category)) problems.push(`${label} has unknown category '${f.category}' (${[...CATEGORIES].join("|")})`)
    if (f.action != null && !FINDING_ACTIONS.has(f.action)) {
      problems.push(`${label} has invalid action '${f.action}' (open|needs_adjudication); record a reservation as a minor finding instead`)
    }
    const ev = f.evidence
    if (ev != null && (typeof ev !== "object" || Array.isArray(ev))) problems.push(`${label} evidence must be an object`)
    else if (ev) {
      if (ev.class != null && !EVIDENCE_CLASSES.has(ev.class)) problems.push(`${label} has unknown evidence.class '${ev.class}' (${[...EVIDENCE_CLASSES].join("|")})`)
      if (ev.verification != null && !VERIFICATIONS.has(ev.verification)) {
        problems.push(`${label} has unknown evidence.verification '${ev.verification}' (${[...VERIFICATIONS].join("|")})`)
      }
    }
  })
  return problems
}

// Structural checks on an Architect response.
export function responseProblems(state: any, response: any, initial: boolean): string[] {
  if (!response || typeof response !== "object" || Array.isArray(response)) return ["response must be a JSON object"]
  const problems: string[] = []
  if (response.responses != null && !Array.isArray(response.responses)) problems.push("response.responses must be an array")
  if (response.decisions != null && !Array.isArray(response.decisions)) problems.push("response.decisions must be an array")
  const expected = initial ? 0 : state.round
  if (response.round != null && Number(response.round) !== expected) {
    problems.push(`response.round ${response.round} does not match ${initial ? "the initial design (0)" : `the current round ${state.round}`}`)
  }
  // The initial design answers no findings.
  if (initial) return problems
  const open = new Set<string>((state.open_findings || []).map((f: any) => String(f.id)))
  const seen = new Set<string>()
  listOf(response.responses).forEach((r: any, i: number) => {
    const label = r?.finding_id ? `response to '${r.finding_id}'` : `response #${i + 1}`
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      problems.push(`${label} is not an object`)
      return
    }
    if (!DISPOSITIONS.has(r.disposition)) problems.push(`${label} has invalid disposition '${r.disposition}' (${[...DISPOSITIONS].join("|")})`)
    // A rebuttal's evidence is held to the same backing rule as a finding's.
    const why = r.disposition === "rebut" && r.refutation_evidence?.verification === "verified" ? unbackedReason(state, r.refutation_evidence) : null
    if (why) problems.push(`${label} claims verified ${r.refutation_evidence.class} evidence with ${why}; record it with design_record_evidence and cite its id as refutation_evidence.artifact_id`)
    const id = String(r.finding_id ?? "")
    if (!open.has(id)) problems.push(`${label} does not name a finding on the board (${[...open].join(", ") || "none"})`)
    else if (seen.has(id)) problems.push(`duplicate response for '${id}'`)
    else seen.add(id)
  })
  return problems
}

// Does the finding cite an evidence artifact recorded in the given round?
function freshEvidenceFor(state: any, finding: any, round: number) {
  const aid = finding?.evidence?.artifact_id
  if (!aid) return false
  const rec = (state?.evidence || []).find((e: any) => e.id === aid)
  return !!rec && rec.round === round
}

// The user's adjudication of a finding in a given round, if any.
export function adjudicationFor(state: any, id: string, round: number): string | null {
  const a = state?.adjudications?.[id]
  if (!a) return null
  if (typeof a === "string") return a // pre-v5 state (the plugin migrates these)
  return a.round === round ? a.decision : null
}

// The validation ladder for one verdict finding and the Architect's response.
export function classifyFinding(state: any, f: any, resp?: any) {
  if (!isCited(f) || !f?.artifact_ref) return { status: "rejected_noise", contested: false }
  // Another subsystem's concern is advisory here, unless it is a verified blocker/major against this design.
  if (!categoryInScope(state, f.category) && !(isBindingEvidence(f) && GATE_SEVERITIES.has(f.severity))) return { status: "advisory", contested: false }
  let base: string
  if (f.action === "needs_adjudication" || f?.evidence?.verification === "disputed") base = "needs_adjudication"
  else if (isBindingEvidence(f)) base = "binding"
  else if (isSupportedEvidence(f)) base = "supported"
  else base = "plausible"
  // The Falsifier put this to the user: the Architect's answer is a proposal until the user rules.
  if (f.action === "needs_adjudication") return { status: "needs_adjudication", contested: isBindingEvidence(f) && GATE_SEVERITIES.has(f.severity) }
  const gateWorthy = base === "binding" && GATE_SEVERITIES.has(f.severity)
  const disposition = resp?.disposition
  if (disposition === "fix" || disposition === "simplify") {
    // A root cannot edit a subsystem's design: its fix stays open (gating) so that subsystem is reopened to make it.
    return delegatesToSubsystem(state, f) ? { status: base, contested: false } : { status: "resolved", contested: false }
  }
  if (disposition === "accept_risk" || disposition === "wont_fix") {
    // Waiving a verified blocker/major is the user's call, not the Architect's.
    return gateWorthy ? { status: "needs_adjudication", contested: true } : { status: "accepted_risk", contested: false }
  }
  if (disposition === "rebut") {
    // A rebut closes a finding only with verified strong evidence, backed like a finding's.
    const ev = resp?.refutation_evidence
    if (STRONG_EVIDENCE.has(ev?.class) && ev?.verification === "verified" && !unbackedReason(state, ev)) return { status: "resolved", contested: false }
    return { status: "needs_adjudication", contested: gateWorthy }
  }
  return { status: base, contested: false }
}

// A finding the user ruled stands: from then on an ordinary verified one the Architect must answer.
function asRatified(f: any) {
  return { ...f, action: "open", evidence: { ...(f?.evidence || {}), class: "authoritative", verification: "verified" } }
}

// The user's "reopen": a finding waiting on their ruling becomes a ratified one; any other re-runs the ladder.
export function reopenStatus(state: any, f: any) {
  const raw = rawFinding(state, f)
  const { status } = classifyFinding(state, raw)
  if (status !== "needs_adjudication") return { status, ratified: false }
  return { status: classifyFinding(state, asRatified(raw)).status, ratified: true }
}

// A decompose root's finding aimed at one of its subsystems (fixable only inside that subsystem).
function delegatesToSubsystem(state: any, f: any) {
  if (!state?.decompose || state.parent_slug || !f?.subsystem_ref) return false
  return (state.subsystems || []).some((s: any) => subsystemMatches(s, f.subsystem_ref))
}

// The verdict form of a stored finding (for re-running the ladder on it).
export function rawFinding(state: any, f: any) {
  const raw = (state?.verdicts?.[f.round]?.findings || []).find((x: any) => x.id === f.id)
  return raw || { ...f, evidence: { class: f.evidence_class, verification: f.verification } }
}

// A held finding carried into a later round: the user's ruling or the Architect's new answer applies.
function carryFinding(state: any, f: any, resp: any) {
  const adj = adjudicationFor(state, f.id, f.round)
  if (adj === "resolved" || adj === "accepted_risk") return { ...f, status: adj, contested: false, decided_by: "user" }
  if (!resp && adj !== "binding") return f
  const raw = rawFinding(state, f)
  const { status, contested } = classifyFinding(state, adj === "binding" ? asRatified(raw) : raw, resp)
  return { ...f, status, contested, disposition: resp?.disposition ?? f.disposition }
}

function riskKey(f: any) {
  return `${f.id}@${f.round ?? ""}`
}

// The accepted-risk ledger updated with findings' current statuses (a reopened risk leaves it).
export function mergeRisks(ledger: any[], findings: any[]) {
  const out = new Map<string, any>((ledger || []).map((r: any) => [riskKey(r), r]))
  for (const f of findings || []) {
    if (f.status !== "accepted_risk") {
      out.delete(riskKey(f))
      continue
    }
    out.set(riskKey(f), {
      id: f.id,
      round: f.round ?? null,
      severity: f.severity,
      category: f.category,
      claim: f.claim,
      accepted_by: f.decided_by === "user" ? "user" : f.disposition || "user",
    })
  }
  return [...out.values()]
}

// A child's unresolved findings and accepted risks, compact, for the root's integration review.
export function looseEnds(child: any) {
  const item = (f: any, status: string) => ({
    subsystem: child.namespace || child.slug,
    id: f.id,
    severity: f.severity,
    category: f.category,
    status,
    claim: String(f.claim || "").slice(0, 200),
  })
  const open = (child.open_findings || []).filter((f: any) => !["resolved", "rejected_noise", "accepted_risk"].includes(f.status))
  return [...open.map((f: any) => item(f, f.status)), ...mergeRisks(child.risks || [], child.open_findings).map((r: any) => item(r, "accepted_risk"))]
}

export function applyValidation(state: any, round: number, verdict: any, response: any) {
  const respById: Record<string, any> = {}
  for (const r of response?.responses || []) respById[r.finding_id] = r
  const prevResolved = new Set<string>((state.history || []).flatMap((h: any) => h.resolved_ids || []))
  const prev: any[] = state.open_findings || []
  // Accepted risks outlive the round that produced them.
  state.risks = mergeRisks(state.risks || [], prev)
  const ids = new Set<string>((verdict?.findings || []).map((f: any) => f.id))
  // A finding waiting on the user stays on the board until decided, even if not re-raised.
  const carried = prev.filter((f: any) => f.held && f.round < round && !ids.has(f.id)).map((f: any) => carryFinding(state, f, respById[f.id]))

  state.open_findings = (verdict?.findings || []).map((f: any) => {
    const resp = respById[f.id]
    // A user adjudication for this round wins; "binding" (reopened) leaves the Architect to answer it.
    const adj = adjudicationFor(state, f.id, round)
    let { status, contested } = classifyFinding(state, adj === "binding" ? asRatified(f) : f, resp)
    if (adj === "resolved" || adj === "accepted_risk") {
      status = adj
      contested = false
    }

    return {
      id: f.id,
      severity: f.severity,
      category: f.category,
      claim: f.claim,
      counterexample: f.counterexample || "",
      suggested_direction: f.suggested_direction || "",
      evidence_class: f?.evidence?.class || null,
      verification: f?.evidence?.verification || null,
      requirement_ids: f.requirement_ids || [],
      constraint_ref: f.constraint_ref || null,
      artifact_ref: f.artifact_ref || "",
      action: f.action || "open",
      subsystem_ref: f.subsystem_ref || null,
      status,
      contested,
      disposition: resp?.disposition || null,
      decided_by: adj === "resolved" || adj === "accepted_risk" ? "user" : null,
      regression: prevResolved.has(f.id),
      round,
    }
  }).concat(carried)
  return state.open_findings
}

// Findings that could actually gate convergence (verified, cited, artifact-backed), including verified
// ones the Falsifier put to the user or outside the run's domains: they still mean the design was not stable.
export function isNewGateFinding(f: any) {
  return (
    GATE_SEVERITIES.has(f?.severity) &&
    isBindingEvidence(f) &&
    isCited(f) &&
    !!f.artifact_ref
  )
}

export function countNewGate(verdict: any) {
  return (verdict?.findings || []).filter(isNewGateFinding).length
}

export function openGate(state: any) {
  return state.open_findings.filter(isGating).length
}

export function beginRound(state: any) {
  state.round += 1
  state.phase = "falsifying"
}

export function scoreFor(state: any) {
  const openB = state.open_findings.filter((f: any) => f.severity === "blocker" && isGating(f)).length
  const openM = state.open_findings.filter((f: any) => f.severity === "major" && isGating(f)).length
  const supportedM = state.open_findings.filter((f: any) => f.severity === "major" && f.status === "supported").length
  const minors = state.open_findings.filter((f: any) => f.severity === "minor" && !["resolved", "accepted_risk"].includes(f.status)).length
  const gaps = (state.coverage?.gaps || []).length
  return Math.max(0, 100 - openB * 25 - openM * 10 - supportedM * 4 - minors * 2 - gaps * 3)
}

// The board is clean when no blocker gates, majors are within threshold, and coverage is complete.
export function boardClean(state: any) {
  return gateClear(state) && (state.coverage?.gaps || []).length === 0
}

// No gating blocker, and gating majors within threshold.
function gateClear(state: any) {
  const openBlockers = state.open_findings.filter((f: any) => f.severity === "blocker" && isGating(f)).length
  const openMajors = state.open_findings.filter((f: any) => f.severity === "major" && isGating(f)).length
  return openBlockers === 0 && openMajors <= state.budgets.majors_threshold
}

// Pre-decomposition rounds do not count against integration budget or convergence.
export function integrationBase(state: any) {
  const n = Number(state?.integration_base_round)
  return state?.integration_base_round != null && Number.isFinite(n) && n > 0 ? n : 0
}

// A parent block holds a subsystem's acceptance for one full round; the root then re-verifies.
export function parentBlockHolds(state: any) {
  if (!state?.acceptance_blocked_by_parent) return false
  const since = Number(state.parent_block_round)
  if (state.parent_block_round == null || !Number.isFinite(since)) return true
  return state.round <= since
}

export function decidePhase(state: any) {
  const verdict = state.verdicts[state.round]
  const selfCert = !!(verdict && verdict.no_new_falsifiable_claim === true)
  const clean = boardClean(state)
  const withinBudget = !state.budgets.max_spec_lines || (state.spec_lines || 0) <= state.budgets.max_spec_lines
  const base = integrationBase(state)
  const recent = (state.history || []).filter((h: any) => (h.round || 0) > base).slice(-state.budgets.k)
  const settled = recent.length >= state.budgets.k
  // Diminishing returns: exactly one new validated finding per round for k rounds.
  const diminishing = settled && recent.every((h: any) => (h.new_validated_gate || 0) === 1)
  // Minor-only returns: k rounds that found only minors; the minors are the reservations (quiet rounds still await self-cert).
  const minorOnly = settled && recent.every((h: any) => !h.new_validated_gate && !h.blockers && !h.majors && (h.minors || 0) > 0)
  // A decomposed root accepts only once required subsystems are accepted and all requirements traced.
  const ready =
    clean &&
    withinBudget &&
    !parentBlockHolds(state) &&
    !state.traceability_blocked &&
    !state.interface_blocked &&
    childrenGate(state) === "ready" &&
    traceabilityGaps(state).length === 0 &&
    interfaceGaps(state).length === 0

  const allowAccepted = state.allowAccepted !== false

  // Strict convergence: ready, self-certified, and k clean rounds.
  if (ready && selfCert && state.rounds_without_new_gate >= state.budgets.k) return "converged"

  // Accepted with reservations: ready and diminishing returns (never when strict).
  if (allowAccepted && ready && (diminishing || minorOnly)) {
    return "accepted_with_reservations"
  }

  if (state.round - base >= state.budgets.max_rounds) return allowAccepted && ready ? "accepted_with_reservations" : "budget_stopped"

  // No progress: the unresolved gating findings have not decreased across m rounds.
  if (state.gate_stall_streak >= state.budgets.m) return "no_progress"

  return "designing"
}

// The single source of truth for finishing a round (shared by design_respond and tests).
export function recordRound(state: any, response: any, reviewedRevision: string) {
  const round = state.round
  const verdict = state.verdicts[round]
  applyValidation(state, round, verdict, response)
  // A finding that needs the user's ruling is surfaced, and held on the board until decided.
  for (const f of state.open_findings) {
    f.held = awaitsUser(f)
    if (f.held) addEscalation(state, { requirement_id: f.id, kind: "finding", round: f.round, reason: `${f.severity} ${f.id}: ${adjudicationWhy(f)}` })
  }
  // Drop escalations whose finding is no longer present before scoring the round.
  withdrawStaleEscalations(state)
  // Adjudications only ever apply to their own round.
  for (const [id, a] of Object.entries(state.adjudications || {})) {
    if (a && typeof a === "object" && Number((a as any).round) < round) delete state.adjudications[id]
  }
  const newGate = countNewGate(verdict)
  state.rounds_without_new_gate = newGate === 0 ? (state.rounds_without_new_gate || 0) + 1 : 0
  const gate = openGate(state)
  // Progress is the Architect's: findings held over from earlier rounds for the user do not stall it.
  const roundGate = state.open_findings.filter((f: any) => f.round === round && isGating(f)).length
  const last = state.history[state.history.length - 1]
  const prevGate = last ? (last.round_gate ?? last.gate) : null
  state.gate_stall_streak = roundGate > 0 ? (prevGate !== null && roundGate >= prevGate ? (state.gate_stall_streak || 0) + 1 : 1) : 0

  const findings = verdict?.findings || []
  const resolvedIds = state.open_findings.filter((f: any) => f.status === "resolved").map((f: any) => f.id)
  const simplifications = (response?.responses || []).filter((r: any) => r.disposition === "simplify").length
  state.history.push({
    round,
    revision_reviewed: reviewedRevision,
    blockers: findings.filter((f: any) => f.severity === "blocker").length,
    majors: findings.filter((f: any) => f.severity === "major").length,
    minors: findings.filter((f: any) => f.severity === "minor").length,
    new_validated_gate: newGate,
    gate,
    round_gate: roundGate,
    contested: state.open_findings.filter((f: any) => f.contested).length,
    score: scoreFor(state),
    coverage_gaps: [...(state.coverage.gaps || [])],
    resolved_ids: resolvedIds,
    simplifications,
    spec_lines: state.spec_lines,
    verdict: verdict?.verdict || "unknown",
  })
  state.phase = gateAcceptance(state, decidePhase(state))
  return { newGate, gate, phase: state.phase }
}

// Verified blockers/majors the Architect closed this round on its own word (fix/simplify).
export function unverifiedFixes(state: any) {
  return (state.open_findings || []).filter(
    (f: any) =>
      f.status === "resolved" &&
      f.decided_by !== "user" &&
      (f.disposition === "fix" || f.disposition === "simplify") &&
      GATE_SEVERITIES.has(f.severity) &&
      STRONG_EVIDENCE.has(f.evidence_class) &&
      f.verification === "verified",
  )
}

// An acceptance resting on unverified fixes waits for one Falsifier pass over them.
export function gateAcceptance(state: any, phase: string) {
  state.verify = null
  const ids = unverifiedFixes(state).map((f: any) => f.id)
  if (!isAcceptedTerminal(phase) || ids.length === 0) return phase
  state.verify = { target: phase, ids, round: state.round }
  return "designing"
}

// The verification verdict settles it: the acceptance stands, or the run goes on (or stops at budget).
export function settleVerification(state: any) {
  const target = state.verify?.target
  state.verify = null
  if (gateClear(state)) return target
  return state.round - integrationBase(state) > state.budgets.max_rounds ? "budget_stopped" : "responding"
}

// After a user ruling on the last scored round: finish a run that now qualifies for acceptance.
export function rescore(state: any) {
  const last = state.history?.[state.history.length - 1]
  if (!last || last.round !== state.round || state.dispatch) return false
  if (!["designing", "budget_stopped", "no_progress"].includes(state.phase)) return false
  const next = gateAcceptance(state, decidePhase(state))
  if (!isAcceptedTerminal(next) && !state.verify) return false
  state.phase = next
  state.stop_reason = null
  return true
}

// Dimensions the Falsifier examined within the last k rounds (since integration began).
export function recentlyExamined(state: any) {
  const from = Math.max(integrationBase(state), state.round - (state.budgets?.k || 1)) + 1
  const out = new Set<string>()
  for (const [r, v] of Object.entries(state.verdicts || {}) as [string, any][]) {
    if (Number(r) < from || Number(r) > state.round) continue
    for (const d of v?.coverage?.examined || []) out.add(String(d))
  }
  return [...out]
}

function cell(text: any) {
  return String(text == null ? "" : text).replace(/[\r\n]+/g, " ").replace(/\|/g, "/")
}

export function renderOpenIssues(state: any) {
  const rows = state.open_findings
    .filter((f: any) => !["resolved", "accepted_risk"].includes(f.status))
    .map((f: any) => `| ${f.id} | ${f.severity} | ${f.category} | ${f.status}${f.contested ? " (contested)" : ""} | ${cell(f.claim).slice(0, 120)} |`)
  // Architect-accepted and user-ratified risks of every round are residual risks too.
  const risks = mergeRisks(state.risks || [], state.open_findings).map(
    (r: any) => `| ${r.id} | ${r.severity} | ${r.category} | ${r.accepted_by} | ${cell(r.claim).slice(0, 120)} |`,
  )
  const escs: any[] = state.escalations?.length ? state.escalations : state.escalation ? [state.escalation] : []
  return `# Open Issues

Run: ${state.slug} (${state.system})
Terminal phase: ${state.phase}${state.stop_reason ? ` (${state.stop_reason})` : ""}
Final revision: ${state.design_revision}
Rounds: ${state.round}

## Residual findings

| ID | Severity | Category | Status | Claim |
| --- | --- | --- | --- | --- |
${rows.length ? rows.join("\n") : "| - | - | - | - | none |"}

## Accepted risks

| ID | Severity | Category | Accepted by | Claim |
| --- | --- | --- | --- | --- |
${risks.length ? risks.join("\n") : "| - | - | - | - | none |"}

## Escalations

${escs.length ? escs.map((e: any) => `- ${e.requirement_id}: ${e.reason} (${e.status})`).join("\n") : "none"}

## Coverage gaps

${(state.coverage?.gaps || []).length ? state.coverage.gaps.join(", ") : "none"}
`
}

export function renderRequirements(state: any) {
  const rows = state.requirements.items.map((r: any) => `| ${r.id} | ${r.priority} | ${cell(r.text)}${r.amended?.length ? ` (amended v${r.amended.at(-1).version})` : ""} | ${cell(r.acceptance)} |`)
  return `# Requirements (version ${state.requirements.version}, ${state.requirements.frozen ? "frozen" : "draft"})

| ID | Priority | Requirement | Acceptance criteria |
| --- | --- | --- | --- |
${rows.length ? rows.join("\n") : "| - | - | none | - |"}
`
}

export function summarize(state: any) {
  return {
    slug: state.slug,
    system: state.system,
    phase: state.phase,
    round: state.round,
    revision: state.design_revision,
    decompose: state.decompose === true,
    decomposition: state.decompose
      ? { mode: state.decomposition_mode || "confirm", ready: state.decomposition_ready === true, error: state.decomposition_error || null }
      : null,
    integration_base_round: state.integration_base_round ?? null,
    preset: state.preset || state.budgets?.mode || "fast",
    budgets: state.budgets,
    spec: { lines: state.spec_lines || 0, budget: state.budgets.max_spec_lines ?? null },
    requirements: { version: state.requirements.version, frozen: state.requirements.frozen, count: state.requirements.items.length },
    decisions: state.decisions.map((d: any) => ({ id: d.id, status: d.status, supersede_count: d.supersede_count })),
    evidence_count: state.evidence.length,
    open_findings: state.open_findings
      .filter((f: any) => !["resolved", "accepted_risk"].includes(f.status))
      .map((f: any) => ({ id: f.id, severity: f.severity, status: f.status, contested: f.contested === true, regression: f.regression })),
    coverage_gaps: state.coverage.gaps,
    interface_gaps: state.interface_gaps || [],
    interface_blocked: state.interface_blocked === true,
    history: state.history,
    paused: state.paused === true,
    stop_reason: state.stop_reason || null,
    dispatch: state.dispatch ? { role: state.dispatch.role, round: state.dispatch.round, child: state.dispatch.child_session_id } : null,
    escalation: state.escalation,
    escalations: state.escalations || (state.escalation ? [state.escalation] : []),
    residual: state.residual,
    updated_at: state.updated_at,
  }
}

// extras carries plugin-only context: the design directory and effective shell policy.
export function handoff(state: any, role: string, extras: { designDir?: string; shellPolicy?: string; looseEnds?: any[]; scratchDir?: string } = {}) {
  return {
    run_id: state.run_id,
    slug: state.slug,
    role,
    phase: state.phase,
    round: state.round,
    design_revision: state.design_revision,
    design_dir: extras.designDir || `docs/design/${state.slug}`,
    scratch_dir: extras.scratchDir || null,
    requirements: state.requirements,
    // The Falsifier stays independent: it never sees the Architect's rationale.
    decisions: role === "falsifier" ? [] : state.decisions,
    evidence: state.evidence.map((e: any) => ({ id: e.id, class: e.class, command: e.command, digest: e.digest })),
    open_findings: state.open_findings.filter((f: any) => !["resolved", "accepted_risk"].includes(f.status)),
    // New findings are numbered from here; an old id means a re-raise of that finding.
    next_finding_id: nextFindingId(state),
    coverage: state.coverage,
    budgets: state.budgets,
    integration_base_round: state.integration_base_round ?? null,
    rubric: { version: 1, thresholds: { majors: state.budgets.majors_threshold, k: state.budgets.k } },
    escalations: state.escalations || (state.escalation ? [state.escalation] : []),
    // Scale/config context: namespace, parent, rejection, subsystems, traceability.
    namespace: state.namespace || null,
    parent_slug: state.parent_slug || null,
    parent_blocks: state.parent_blocks || [],
    parent_block_findings: state.parent_block_findings || [],
    acceptance_blocked_by_parent: state.acceptance_blocked_by_parent || null,
    domains: state.domains || [],
    subsystems: (state.subsystems || []).map((s: any) => ({
      name: s.name,
      namespace: s.namespace,
      title: s.title || null,
      required: s.required !== false,
      depends_on: s.depends_on || [],
      provides: s.provides || [],
      requires: s.requires || [],
    })),
    // Subsystems' unresolved/accepted findings: the root's Falsifier otherwise never sees cross-subsystem gaps they left.
    subsystem_loose_ends: extras.looseEnds || [],
    children: state.children || [],
    waiting_on: state.waiting_on || [],
    traceability: state.traceability || [],
    interfaces: state.interfaces || [],
    interface_gaps: interfaceGaps(state),
    config: {
      preset: state.preset || state.budgets?.mode || "fast",
      models: state.models || {},
      shellPolicy: extras.shellPolicy || state.shellPolicy || "guarded",
      strict: state.allowAccepted === false,
      max_parallel: state.max_parallel ?? null,
    },
  }
}
