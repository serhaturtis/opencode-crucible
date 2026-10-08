import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs/promises"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import {
  SCHEMA_VERSION,
  REQUIRED_DIMENSIONS,
  GATE_SEVERITIES,
  TERMINAL,
  nowIso,
  slugify,
  normalizeSlug,
  nextRevision,
  nextId,
  upsertDecisions,
  digest,
  newState,
  budgetsFor,
  presetBudgets,
  downgradeUnbackedEvidence,
  verdictProblems,
  responseProblems,
  applyValidation,
  recordRound,
  beginRound,
  renderOpenIssues,
  renderRequirements,
  summarize,
  handoff,
  isDestructive,
  childrenGate,
  effectiveRequired,
  traceabilityGaps,
  interfaceGaps,
  interfaceGapDetails,
  manifestProblems,
  subsystemBlocks,
  subsystemMatches,
  refreshCoverage,
  isAcceptedTerminal,
  withinDir,
  addEscalation,
  removeEscalation,
  acknowledgeEscalation,
  isFindingEscalation,
  withdrawStaleEscalations,
  boardClean,
  rescore,
  settleVerification,
  unverifiedFixes,
  reopenStatus,
  awaitsUser,
  recentlyExamined,
  adjudicationWhy,
  looseEnds,
} from "./core"
import { PROTOCOL } from "./protocol"
import { enqueueEvent } from "./events"

const z = tool.schema

// Crucible plugin: persistence, scheduler, tools, injected agents (pure logic in ./core).

// A dispatched turn is killed only after this much silence (no token, tool call, or status event).
const WATCHDOG_DEFAULT_MS = 10 * 60 * 1000
// While a tool call runs (e.g. a long benchmark) silence is expected for longer.
const TOOL_WATCHDOG_MS = 30 * 60 * 1000
const WATCHDOG_SWEEP_DEFAULT_MS = 30 * 1000
const BUSY_GRACE_MS = 5000
// How often a live turn's activity is written to its run state (for the TUI).
const HEARTBEAT_PERSIST_MS = 60 * 1000
// Bus events that prove a dispatched child session is still alive.
const WATCHDOG_ACTIVITY_EVENTS = new Set([
  "message.updated",
  "message.part.updated",
  "session.status",
  "session.compacted",
  "permission.replied",
])
const SHELL_POLICIES = new Set(["guarded", "allow", "ask"])

// The SDK client and plugin options are shared across opencode instances; calls pass their run's directory explicitly.
let CLIENT: any = null
let OPTIONS: any = {}
// The server's own URL, for API routes the SDK client lacks.
let SERVER_URL: URL | null = null

// child session id -> the last time it showed activity, plus where its run lives.
const watchdogs = new Map<string, { last: number; persisted: number; dir: string; slug: string; timeout: number; tools: Set<string>; waiting: boolean }>()
const lastCompacted = new Map<string, number>()
const advancing = new Set<string>()
const chains = new Map<string, Promise<any>>()
const recoveredDirs = new Set<string>()
let watchdogSweeper: ReturnType<typeof setInterval> | null = null

// Plugin-level default inactivity window, overridable by a run's `watchdog_ms`.
function watchdogMs() {
  const n = Number(OPTIONS.watchdogMs)
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_DEFAULT_MS
}

function effectiveWatchdogMs(state: any) {
  const n = Number(state?.watchdog_ms)
  return Number.isFinite(n) && n > 0 ? n : watchdogMs()
}

// Sweeper interval for silent dispatches (test-only knob).
function watchdogSweepMs() {
  const n = Number(OPTIONS.watchdogSweepMs)
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_SWEEP_DEFAULT_MS
}

// How often a live turn's activity is persisted for the TUI.
function heartbeatMs() {
  const n = Number(OPTIONS.heartbeatMs)
  return Number.isFinite(n) && n > 0 ? n : HEARTBEAT_PERSIST_MS
}

// The run's shell policy, else the plugin's `shellPolicy` option, else guarded.
function effectiveShellPolicy(state: any) {
  if (SHELL_POLICIES.has(state?.shellPolicy)) return state.shellPolicy
  return SHELL_POLICIES.has(OPTIONS.shellPolicy) ? OPTIONS.shellPolicy : "guarded"
}

// The session an event belongs to (shapes vary: part/info/sessionID).
function eventSessionID(event: any): string | null {
  const p = event?.properties
  return p?.sessionID || p?.part?.sessionID || p?.info?.sessionID || null
}

// A readable message from an SDK error payload (`{ error }` results).
function errorText(error: any) {
  return String(error?.data?.message || error?.message || error?.name || JSON.stringify(error))
}

// Serialize all state mutations for a run so the scheduler and tools cannot interleave a read-modify-write.
function lockKey(dir: string, slug: string) {
  return `${path.resolve(dir)}::${slug}`
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) || Promise.resolve()
  const run = prev.then(fn, fn) as Promise<T>
  const settled = run.then(
    () => {},
    () => {},
  )
  chains.set(key, settled)
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return run
}

function injectAgent(cfg: any, name: string, defaults: any) {
  cfg.agent = cfg.agent || {}
  const existing = { ...(cfg.agent[name] || {}) }
  const merged: any = { ...defaults, ...existing }
  merged.prompt = defaults.prompt
  merged.mode = defaults.mode
  merged.description = existing.description || defaults.description
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  cfg.agent[name] = merged
}

// --- persistence -----------------------------------------------------------

function dataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode-crucible")
}

function registryFile() {
  return path.join(dataDir(), "sessions.json")
}

// Candidate docs/design roots for a worktree (canonical plus an immediate subdirectory's), sorted.
function designRoots(dir: string): string[] {
  const roots: string[] = []
  const direct = path.join(dir, "docs", "design")
  if (existsSync(direct)) roots.push(direct)
  try {
    const nested = readdirSync(dir, { withFileTypes: true })
      .filter((e: any) => e.isDirectory() && !e.name.startsWith("."))
      .map((e: any) => path.join(dir, e.name, "docs", "design"))
      .filter((p: string) => existsSync(p))
      .sort()
    roots.push(...nested)
  } catch {
  }
  return roots
}

// Resolve a run's directory: the design root already holding the slug, else the canonical docs/design/<slug>.
function designDir(dir: string, slug: string) {
  const canonical = path.join(dir, "docs", "design", slug)
  if (existsSync(canonical)) return canonical
  for (const root of designRoots(dir)) {
    const candidate = path.join(root, slug)
    if (existsSync(candidate)) return candidate
  }
  return canonical
}

// The run directory relative to the worktree, as agents address it.
function relDesignDir(dir: string, slug: string) {
  return (path.relative(dir, designDir(dir, slug)) || ".").split(path.sep).join("/")
}

function stateFile(dir: string, slug: string) {
  return path.join(designDir(dir, slug), ".crucible", "state.json")
}

async function readJson(file: string, fallback: any) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file: string, value: any) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Math.random().toString(36).slice(2)}`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2))
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

function migrate(state: any) {
  if (!state || typeof state !== "object") return state
  state.requirements = state.requirements || { version: 1, frozen: false, items: [] }
  state.requirements.items = state.requirements.items || []
  state.decisions = state.decisions || []
  state.evidence = state.evidence || []
  state.open_findings = state.open_findings || []
  state.verdicts = state.verdicts || {}
  state.responses = state.responses || {}
  state.history = state.history || []
  state.managed_sessions = state.managed_sessions || []
  state.residual = state.residual || []
  state.coverage = state.coverage || {}
  state.coverage.required = state.coverage.required || [...REQUIRED_DIMENSIONS]
  state.coverage.examined = state.coverage.examined || []
  state.coverage.gaps = state.coverage.gaps || [...REQUIRED_DIMENSIONS]
  state.budgets = state.budgets || budgetsFor(undefined)
  state.phase = state.phase || "eliciting"
  state.round = state.round || 0
  state.design_revision = state.design_revision || "v0"
  state.paused = state.paused === true
  state.dispatch_error_count = state.dispatch_error_count || 0
  state.rounds_without_new_gate = state.rounds_without_new_gate || 0
  state.gate_stall_streak = state.gate_stall_streak || 0
  state.spec_lines = state.spec_lines || 0
  state.stall_count = state.stall_count || 0
  state.sessions = state.sessions || {}
  state.decompose = state.decompose === true
  state.parent_slug = state.parent_slug || null
  state.subsystems = state.subsystems || []
  state.namespace = state.namespace || null
  state.traceability = state.traceability || []
  state.interfaces = state.interfaces || []
  state.interface_gaps = state.interface_gaps || []
  state.interface_blocked = state.interface_blocked === true
  state.domains = state.domains || []
  state.watchdog_ms = state.watchdog_ms ?? null
  state.waiting_on = state.waiting_on || []
  state.children = state.children || []
  state.effort = state.effort || state.slug
  state.acceptance_blocked_by_parent = state.acceptance_blocked_by_parent || null
  state.parent_blocks = state.parent_blocks || []
  state.parent_block_findings = state.parent_block_findings || []
  state.parent_block_round = state.parent_block_round ?? null
  state.parent_reject_count = state.parent_reject_count || 0
  state.decomposition_version = state.decomposition_version ?? null
  state.decomposition_mode = state.decomposition_mode || "confirm"
  state.decomposition_ready = state.decomposition_ready === true
  state.decomposition_error = state.decomposition_error ?? null
  state.integration_base_round = state.integration_base_round ?? null
  state.max_parallel = state.max_parallel ?? null
  state.traceability_blocked = state.traceability_blocked === true
  state.preset = state.preset || null
  state.models = state.models || {}
  state.shellPolicy = state.shellPolicy || null
  state.allowAccepted = state.allowAccepted !== false
  state.escalation = state.escalation ?? null
  state.escalations = state.escalations || (state.escalation ? [state.escalation] : [])
  state.risks = state.risks || []
  state.adjudications = state.adjudications || {}
  // v5: adjudications are scoped to the round they were made in.
  for (const [id, a] of Object.entries(state.adjudications)) {
    if (typeof a === "string") state.adjudications[id] = { decision: a, round: state.round }
  }
  state.escalation_notified = state.escalation_notified === true
  state.spec_over_notified = state.spec_over_notified === true
  state.paused_reason = state.paused_reason ?? null
  state.stopped_from = state.stopped_from ?? null
  state.stop_reason = state.stop_reason ?? null
  state.session_policy = state.session_policy || {}
  state.verify = state.verify ?? null
  state.notes = state.notes || ""
  state.schema_version = SCHEMA_VERSION
  return state
}

async function readState(dir: string, slug: string) {
  const file = stateFile(dir, slug)
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    return null
  }
  try {
    return migrate(JSON.parse(raw))
  } catch {
    try {
      await fs.rename(file, `${file}.corrupt.${Date.now()}`)
    } catch {
    }
    return null
  }
}

async function saveState(dir: string, state: any) {
  state.updated_at = nowIso()
  await writeJsonAtomic(stateFile(dir, state.slug), state)
}

async function writeRequirements(dir: string, state: any) {
  await fs.writeFile(path.join(designDir(dir, state.slug), "01-requirements.md"), renderRequirements(state))
}

// Total lines of the design's Markdown (budget; excludes the review log and open issues).
async function specSize(dir: string, slug: string) {
  const lines = (text: string) => (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0))
  let total = 0
  const walk = async (base: string, top: boolean) => {
    let entries: any[]
    try {
      entries = await fs.readdir(base, { withFileTypes: true })
    } catch {
      return // no design dir yet
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue
      const full = path.join(base, e.name)
      if (e.isDirectory()) {
        await walk(full, false)
        continue
      }
      if (!e.name.endsWith(".md")) continue
      if (top && (e.name === "07-review-log.md" || e.name === "08-open-issues.md")) continue
      try {
        total += lines(await fs.readFile(full, "utf8"))
      } catch {
      }
    }
  }
  await walk(designDir(dir, slug), true)
  return total
}

function normalizeRegistryEntry(entry: any) {
  if (!entry || typeof entry !== "object") return { current: null as string | null, runs: {} as Record<string, any> }
  if (entry.runs) return { current: entry.current || null, runs: entry.runs }
  if (entry.slug) return { current: entry.slug, runs: { [entry.slug]: { dir: entry.dir, at: entry.at } } }
  return { current: null, runs: {} as Record<string, any> }
}

async function bindSession(dir: string, sessionID: string | undefined, slug: string) {
  if (!sessionID) return
  await withLock("@registry", async () => {
    const reg = await readJson(registryFile(), {})
    const entry = normalizeRegistryEntry(reg[sessionID])
    entry.runs[slug] = { dir, at: nowIso() }
    entry.current = slug
    reg[sessionID] = entry
    await writeJsonAtomic(registryFile(), reg)
  })
}

async function sessionRuns(sessionID: string | undefined) {
  if (!sessionID) return [] as any[]
  const reg = await readJson(registryFile(), {})
  const entry = normalizeRegistryEntry(reg?.[sessionID])
  return Object.entries(entry.runs).map(([slug, meta]: [string, any]) => ({ slug, dir: meta?.dir, at: meta?.at }))
}

function sameDir(a: string | undefined, b: string) {
  return !a || path.resolve(a) === path.resolve(b)
}

// The session's bound runs that live in this worktree.
async function boundRunsIn(dir: string, sessionID: string | undefined) {
  return (await sessionRuns(sessionID)).filter((r: any) => sameDir(r.dir, dir))
}

function childSlug(root: any, sub: any) {
  return sub.slug || `${root.slug}--${slugify(sub.name)}`
}

// The effort containing a run: its root plus every subsystem of that root.
async function effortSlugs(dir: string, seedSlug: string) {
  const seed = await readState(dir, seedSlug)
  if (!seed) return [seedSlug]
  const rootSlug = seed.parent_slug || seed.slug
  const root = seed.parent_slug ? (await readState(dir, rootSlug)) || seed : seed
  const out = new Set<string>([rootSlug])
  for (const sub of root.subsystems || []) out.add(childSlug(root, sub))
  return [...out]
}

// Every effort touched by this session (a bound root, or a bound subsystem's root).
async function sessionEffortSlugs(dir: string, sessionID: string | undefined) {
  const out = new Set<string>()
  for (const r of await boundRunsIn(dir, sessionID)) {
    for (const s of await effortSlugs(dir, r.slug)) out.add(s)
  }
  return [...out]
}

// Every run with state in this worktree's design roots.
async function worktreeSlugs(dir: string) {
  const out = new Set<string>()
  for (const root of designRoots(dir)) {
    try {
      for (const name of await fs.readdir(root)) {
        if (existsSync(path.join(root, name, ".crucible", "state.json"))) out.add(name)
      }
    } catch {
    }
  }
  return [...out]
}

// Runs recorded in the registry, restricted to one worktree.
async function registryRuns(dir: string) {
  const reg = await readJson(registryFile(), {})
  const seen = new Map<string, any>()
  for (const entry of Object.values(reg || {}) as any[]) {
    const norm = normalizeRegistryEntry(entry)
    for (const [slug, meta] of Object.entries(norm.runs) as [string, any][]) {
      if (!meta?.dir || !sameDir(meta.dir, dir)) continue
      if (!seen.has(slug)) seen.set(slug, { slug, dir: meta.dir, at: meta?.at })
    }
  }
  return [...seen.values()]
}

async function resolveSlug(dir: string, explicit: string | undefined, sessionID: string | undefined) {
  if (explicit) return normalizeSlug(explicit)
  const reg = await readJson(registryFile(), {})
  const entry = normalizeRegistryEntry(reg?.[sessionID || ""])
  // Prefer the current run, but skip a stale pointer and fall back to a bound run whose state exists.
  const candidates = [entry.current, ...Object.keys(entry.runs)].filter(Boolean) as string[]
  for (const slug of candidates) {
    const meta = entry.runs[slug]
    if (meta?.dir && dir && !sameDir(meta.dir, dir)) continue
    if (await readState(dir, slug)) return slug
  }
  return null
}

// For mutations: require an explicit slug when the session has several runs.
async function resolveSlugStrict(dir: string, explicit: string | undefined, sessionID: string | undefined) {
  if (explicit) return normalizeSlug(explicit)
  const runs: any[] = []
  for (const r of await boundRunsIn(dir, sessionID)) {
    if (await readState(dir, r.slug)) runs.push(r)
  }
  if (runs.length === 0) return null
  if (runs.length === 1) return runs[0].slug
  throw new Error(`Multiple Crucible runs are bound to this session (${runs.map((r: any) => r.slug).join(", ")}). Pass an explicit slug.`)
}

async function requireState(dir: string, explicit: string | undefined, sessionID: string | undefined) {
  const slug = await resolveSlug(dir, explicit, sessionID)
  if (!slug) throw new Error("No active Crucible run for this session. Call design_start first.")
  const state = await readState(dir, slug)
  if (!state) throw new Error(`No run state found for slug '${slug}'.`)
  return { slug, state }
}

// One lock per effort (root plus children), so there is no lock nesting.
function effortOf(state: any) {
  return (state && state.effort) || (state && state.slug) || null
}

async function lockForRun(dir: string, slug: string) {
  const state = await readState(dir, slug) // unlocked read of an immutable field
  return lockKey(dir, "@effort:" + (effortOf(state) || slug))
}

// The run and role of a dispatched child session, or null for any other session.
// Recent bash runs per dispatched session, so executable evidence is what the agent really ran, not what it typed.
const shellRuns = new Map<string, Array<{ command: string; output: string; exit: number | null; at: number }>>()

async function callerRun(dir: string, sessionID: string | undefined) {
  if (!sessionID) return null
  for (const r of await boundRunsIn(dir, sessionID)) {
    const state = await readState(dir, r.slug)
    if (!state || !(state.managed_sessions || []).includes(sessionID)) continue
    const role = (Object.entries(state.sessions || {}).find(([, id]) => id === sessionID)?.[0] as string) || null
    return { slug: r.slug, role, state }
  }
  return null
}

// Protocol hard rules: a dispatched Architect/Falsifier may use only its own role's tools on its own run.
async function assertCaller(dir: string, sessionID: string | undefined, toolName: string, roles: string[], targetSlug?: string) {
  const caller = await callerRun(dir, sessionID)
  if (!caller) return
  if (!caller.role || !roles.includes(caller.role)) {
    const who = caller.role ? `the ${caller.role}` : "a dispatched agent"
    throw new Error(`${toolName} is not available to ${who} of run '${caller.slug}' (${roles.length ? `${roles.join("/")} only` : "Referee only"}).`)
  }
  if (targetSlug && targetSlug !== caller.slug) throw new Error(`The ${caller.role} of run '${caller.slug}' cannot act on run '${targetSlug}'.`)
}

// Resolve, lock, read, then run a mutating callback under the run lock.
async function lockedState(
  dir: string,
  explicit: string | undefined,
  sessionID: string | undefined,
  fn: (slug: string, state: any) => Promise<any>,
  access?: { tool: string; roles: string[] },
) {
  const slug = await resolveSlugStrict(dir, explicit, sessionID)
  if (!slug) throw new Error("No active Crucible run for this session. Call design_start first.")
  if (access) await assertCaller(dir, sessionID, access.tool, access.roles, slug)
  return withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state) throw new Error(`No run state found for slug '${slug}'.`)
    return fn(slug, state)
  })
}

// Merge a child requirement's system_reqs into the root's traceability (caller holds the lock).
async function mergeRootTraceability(dir: string, childState: any, item: any) {
  const root = await readState(dir, childState.parent_slug)
  if (!root) return
  root.traceability = root.traceability || []
  for (const sysId of item.system_reqs || []) {
    let entry = root.traceability.find((t: any) => t.system_req === sysId)
    if (!entry) {
      entry = { system_req: sysId, subsystems: [], subsystem_reqs: [] }
      root.traceability.push(entry)
    }
    if (!entry.subsystems.includes(childState.slug)) entry.subsystems.push(childState.slug)
    if (!entry.subsystem_reqs.includes(item.id)) entry.subsystem_reqs.push(item.id)
  }
  await saveState(dir, root)
}

// Rebuild a root's children summary from child state files.
async function buildChildren(dir: string, root: any) {
  const out: any[] = []
  for (const sub of root.subsystems || []) {
    const slug = childSlug(root, sub)
    const child = await readState(dir, slug)
    if (!child) continue
    out.push({
      slug,
      name: sub.name,
      required: sub.required !== false,
      depends_on: sub.depends_on || [],
      phase: child.phase,
      round: child.round,
      acceptance_blocked_by_parent: child.acceptance_blocked_by_parent || null,
      untraced_must: (child.requirements?.items || []).filter((r: any) => r.priority === "must" && !(r.system_reqs && r.system_reqs.length)).length,
    })
  }
  return out
}

// The (effectively) required subsystems the root is still waiting on.
function waitingOn(root: any) {
  const required = effectiveRequired(root)
  return (root.children || []).filter((c: any) => required.has(c.name) && !isAcceptedTerminal(c.phase)).map((c: any) => c.slug)
}

// A root cannot accept while a required subsystem is untraced or a declared interface is unsatisfiable.
async function applyRootGuards(dir: string, root: any) {
  if (!root?.decompose || root.parent_slug) return
  const required = effectiveRequired(root)
  root.traceability_blocked = (root.children || []).some((c: any) => required.has(c.name) && (c.untraced_must || 0) > 0)
  if (root.traceability_blocked) {
    addEscalation(root, { requirement_id: "traceability", kind: "guard", reason: "a required subsystem has a must requirement not traced to a system requirement" })
  } else if ((root.escalations || []).some((e: any) => e.requirement_id === "traceability")) {
    // Traceability restored: withdraw the stale escalation.
    removeEscalation(root, "traceability")
  }
  const details = interfaceGapDetails(root)
  root.interface_gaps = details.map((d) => d.gap)
  root.interface_blocked = details.length > 0
  const settled = details.filter((d) => d.settled)
  if (settled.length) {
    addEscalation(root, { requirement_id: "interface", kind: "guard", reason: `interface gate: ${settled[0].gap}` })
  } else if ((root.escalations || []).some((e: any) => e.requirement_id === "interface")) {
    removeEscalation(root, "interface")
  }
  // A newly raised guard escalation reaches the user as a question dialog.
  await notifyEscalations(dir, root)
}

async function refreshParent(dir: string, childState: any) {
  if (!childState?.parent_slug) return
  const root = await readState(dir, childState.parent_slug)
  if (!root) return
  root.children = await buildChildren(dir, root)
  root.waiting_on = waitingOn(root)
  await applyRootGuards(dir, root)
  await saveState(dir, root)
}

// Cross-run effects of a subsystem change: refresh its root and release dependents.
async function afterRunChange(dir: string, state: any) {
  if (!state?.parent_slug) return
  await refreshParent(dir, state)
  await pumpChildren(dir, state.parent_slug)
}

// Apply a root's gating subsystem findings to its children as acceptance blocks.
async function propagateBlocks(dir: string, root: any, reopen: boolean): Promise<string[]> {
  if (!root?.decompose || root.parent_slug) return []
  // A terminal root must not reopen or dispatch its subsystems.
  if (TERMINAL.has(root.phase)) return []
  const blocks = subsystemBlocks(root)
  const reopened: string[] = []
  let escalated = false
  for (const sub of root.subsystems || []) {
    const slug = childSlug(root, sub)
    const child = await readState(dir, slug)
    if (!child) continue
    const ids = blocks.filter((b: any) => subsystemMatches({ ...sub, slug }, b.name)).map((b: any) => b.finding_id)
    if (ids.length) {
      const fresh = !child.acceptance_blocked_by_parent
      child.acceptance_blocked_by_parent = ids[0]
      child.parent_blocks = ids
      // The subsystem must see what the parent rejected, not just an id.
      child.parent_block_findings = (root.open_findings || [])
        .filter((f: any) => ids.includes(f.id))
        .map((f: any) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          claim: f.claim,
          counterexample: f.counterexample || "",
          suggested_direction: f.suggested_direction || "",
          artifact_ref: f.artifact_ref || "",
          root_round: root.round,
        }))
      if (fresh) child.parent_block_round = child.round
      // Reopen an accepted subsystem the root rejected so it can rework (bounded, then escalate).
      if (reopen && isAcceptedTerminal(child.phase)) {
        const rejectCount = (child.parent_reject_count || 0) + 1
        child.parent_reject_count = rejectCount
        if (rejectCount > 2) {
          addEscalation(root, { requirement_id: child.slug, kind: "subsystem", reason: `subsystem ${child.slug} rejected by the parent ${rejectCount} times` })
          escalated = true
        } else {
          child.phase = "designing"
          child.dispatch = null
          child.paused = false
          child.stop_reason = null
          // The rework starts now: acceptance waits for a round after this one.
          child.parent_block_round = child.round
          reopened.push(child.slug)
        }
      }
    } else if (child.acceptance_blocked_by_parent) {
      child.acceptance_blocked_by_parent = null
      child.parent_blocks = []
      child.parent_block_findings = []
      child.parent_block_round = null
    } else {
      continue
    }
    await saveState(dir, child)
  }
  if (reopened.length) {
    // The root must see reopened subsystems as in progress, not stale accepted phases.
    root.children = await buildChildren(dir, root)
    root.waiting_on = waitingOn(root)
  }
  if (escalated) await notifyEscalations(dir, root)
  return reopened
}

function mergeTraceability(existing: any[], incoming: any[]) {
  const map = new Map<string, any>()
  for (const t of [...(existing || []), ...(incoming || [])]) {
    if (!t?.system_req) continue
    const e = map.get(t.system_req) || { system_req: t.system_req, subsystems: [], subsystem_reqs: [] }
    e.subsystems = Array.from(new Set([...(e.subsystems || []), ...(t.subsystems || [])]))
    e.subsystem_reqs = Array.from(new Set([...(e.subsystem_reqs || []), ...(t.subsystem_reqs || [])]))
    map.set(t.system_req, e)
  }
  return [...map.values()]
}

// The Architect writes this next to its design so decomposition can be ingested.
function decompositionFile(dir: string, slug: string) {
  return path.join(designDir(dir, slug), "decomposition.json")
}

async function readDecompositionManifest(dir: string, slug: string) {
  try {
    return JSON.parse(await fs.readFile(decompositionFile(dir, slug), "utf8"))
  } catch {
    return null
  }
}

// Structural validation shared by the tool and the automatic path (caller holds the lock).
function validateDecomposition(state: any, slug: string, manifest: any) {
  const problems: string[] = []
  if (!manifest || typeof manifest !== "object") return { problems: ["manifest is not an object"] }
  if (manifest.system_slug && slugify(manifest.system_slug) !== slug) problems.push(`manifest.system_slug '${manifest.system_slug}' does not match run '${slug}'`)
  const established = state.subsystems || []
  if (established.length > 0) {
    if (Number(manifest.version) !== Number(state.decomposition_version)) problems.push("a decomposition is already established at a different version")
    else {
      // A re-ingest cannot drop an existing subsystem or add one mid-effort.
      const before = new Set<string>(established.map((s: any) => s.name))
      const after = new Set<string>((Array.isArray(manifest.subsystems) ? manifest.subsystems : []).map((s: any) => s?.name))
      const dropped = [...before].filter((n) => !after.has(n))
      const added = [...after].filter((n) => !before.has(n))
      if (dropped.length || added.length) {
        problems.push(
          `a re-ingest of version ${state.decomposition_version} must keep the established subsystems` +
            `${dropped.length ? ` (dropped: ${dropped.join(", ")})` : ""}${added.length ? ` (added: ${added.join(", ")})` : ""}`,
        )
      }
    }
  }
  const items = state.requirements?.items || []
  const systemReqs = items.filter((r: any) => r.priority === "must" || r.priority === "should").map((r: any) => r.id)
  const allReqs = items.map((r: any) => r.id)
  problems.push(...manifestProblems(manifest, systemReqs, allReqs))
  return { problems }
}

// Recompute a root's decomposition readiness from the manifest on disk.
async function refreshDecomposition(dir: string, slug: string) {
  return withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state) return null
    if (!state.decompose || (state.subsystems || []).length > 0 || state.phase !== "awaiting_decomposition") return state
    const manifest = await readDecompositionManifest(dir, slug)
    const { problems } = manifest ? validateDecomposition(state, slug, manifest) : { problems: ["the Architect has not written decomposition.json"] }
    const ready = !!manifest && problems.length === 0
    if (ready !== (state.decomposition_ready === true) || JSON.stringify(problems) !== JSON.stringify(state.decomposition_error || null)) {
      state.decomposition_ready = ready
      state.decomposition_error = ready ? null : problems
      await saveState(dir, state)
    }
    return state
  })
}

// Create the subsystem runs and persist the root (caller starts the pump).
async function ingestDecomposition(dir: string, slug: string, state: any, manifest: any, existing: boolean) {
  const subs = (manifest.subsystems || []).map((s: any) => ({ ...s, slug: `${slugify(slug)}--${slugify(s.name)}` }))
  // Subsystem runs live next to their root (which may be under a nested root).
  const siblingsDir = path.dirname(designDir(dir, slug))
  for (const s of subs) {
    const childExisting = await readState(dir, s.slug)
    if (childExisting) continue // idempotent: never mutate a started child
    const child = newState(s.slug, s.title || s.name, undefined, s.mode)
    // A subsystem inherits the root's budget tier and per-run settings unless the manifest names a mode.
    if (s.mode) child.preset = s.mode
    else {
      child.budgets = { ...state.budgets }
      child.preset = state.preset || null
    }
    child.models = { ...(state.models || {}) }
    child.shellPolicy = state.shellPolicy || null
    child.allowAccepted = state.allowAccepted !== false
    child.watchdog_ms = state.watchdog_ms ?? null
    child.parent_slug = slug
    child.effort = slug
    child.namespace = s.namespace
    child.domains = s.domains || []
    child.coverage.required = s.domains?.length ? [...s.domains] : [...REQUIRED_DIMENSIONS]
    child.coverage.gaps = [...child.coverage.required]
    child.phase = "designing"
    child.requirements.frozen = true
    child.requirements.items = (s.requirements || []).map((r: any) => ({
      id: r.id,
      text: r.text || "",
      priority: r.priority || "must",
      acceptance: r.acceptance || "",
      status: "open",
      system_reqs: r.system_reqs || [],
    }))
    const cdir = path.join(siblingsDir, s.slug)
    await fs.mkdir(path.join(cdir, ".crucible", "verdicts"), { recursive: true })
    await fs.mkdir(path.join(cdir, ".crucible", "responses"), { recursive: true })
    await fs.mkdir(path.join(cdir, ".crucible", "evidence"), { recursive: true })
    await fs.writeFile(path.join(cdir, "00-brief.md"), `# Subsystem: ${s.title || s.name}\n\nParent: ${slug}\n\n${s.boundary || ""}\n`)
    await writeRequirements(dir, child)
    await saveState(dir, child)
  }
  state.subsystems = subs
  state.decomposition_version = manifest.version
  state.traceability = mergeTraceability(existing ? state.traceability || [] : [], manifest.traceability || [])
  // A re-ingest of the same version replaces the declared interfaces.
  state.interfaces = Array.isArray(manifest.interfaces) ? manifest.interfaces : []
  // A configured max_parallel must survive a manifest that omits it.
  if (manifest.max_parallel != null) state.max_parallel = Number(manifest.max_parallel)
  state.children = await buildChildren(dir, state)
  state.waiting_on = waitingOn(state)
  await applyRootGuards(dir, state)
  // Persist the accepted manifest next to the design for auditability.
  await writeJsonAtomic(decompositionFile(dir, slug), manifest)
  state.decomposition_ready = false
  state.decomposition_error = null
  if (!existing) {
    // Integration rounds start here: fresh round budget and convergence evidence.
    state.integration_base_round = state.round
    state.rounds_without_new_gate = 0
    state.gate_stall_streak = 0
  }
  // The first ingest ends the decomposition hold; a re-ingest never rewinds a mid-round root.
  if (!existing || state.phase === "awaiting_decomposition") state.phase = "designing"
  await saveState(dir, state)
  return subs
}

// Wake the Referee session to put the proceed/cancel question to the user.
async function promptReferee(dir: string, sessionId: string | null | undefined, text: string) {
  if (!CLIENT?.session?.promptAsync || !sessionId) return
  try {
    // The Referee runs as the built-in build agent (only built-in primaries get the question tool).
    await CLIENT.session.promptAsync({
      path: { id: sessionId },
      body: { agent: "build", parts: [{ type: "text", text: `You are acting as the Crucible Referee. ${text}` }] },
      query: { directory: dir },
    })
  } catch {
  }
}

// Open a clean decompose root's decomposition hold: auto-ingest a valid manifest, else put it to the user.
async function holdForDecomposition(dir: string, slug: string, state: any): Promise<boolean> {
  const rel = relDesignDir(dir, slug)
  const manifest = await readDecompositionManifest(dir, slug)
  const { problems: manifestIssues } = manifest ? validateDecomposition(state, slug, manifest) : { problems: ["the Architect has not written decomposition.json"] }
  if (manifest && manifestIssues.length === 0 && (state.decomposition_mode || "confirm") === "auto") {
    // Fully automatic: ingest without asking (the caller pumps the children after saving).
    await ingestDecomposition(dir, slug, state, manifest, false)
    return true
  } else if (manifest && manifestIssues.length === 0) {
    state.phase = "awaiting_decomposition"
    state.decomposition_ready = true
    state.decomposition_error = null
    await notify(dir, `Crucible ${state.slug}: decomposition ready — awaiting your approval`, "warning")
    await promptReferee(
      dir,
      state.session_id,
      `Crucible run '${state.slug}' has written ${rel}/decomposition.json and is holding in awaiting_decomposition. Read the design, then call the \`question\` tool NOW (do not only describe it) with options Approve / Edit / Cancel. On approval call design_decompose with { slug: "${state.slug}" } (it ingests decomposition.json). If I cancel, leave the run in awaiting_decomposition.`,
    )
  } else {
    state.phase = "awaiting_decomposition"
    state.decomposition_ready = false
    state.decomposition_error = manifestIssues
    await notify(dir, `Crucible ${state.slug}: decomposition needs a manifest (${manifestIssues[0] || "not written"})`, "warning")
    await promptReferee(
      dir,
      state.session_id,
      `Crucible run '${state.slug}' is holding in awaiting_decomposition but no valid decomposition.json is present (${manifestIssues[0] || "not written"}). Draft ${rel}/decomposition.json from the design, then call the \`question\` tool NOW (Approve / Edit / Cancel) before calling design_decompose with { slug: "${state.slug}" }.`,
    )
  }
  return false
}

function assertPhase(state: any, allowed: string[]) {
  if (!allowed.includes(state.phase)) {
    throw new Error(`Illegal transition: phase is '${state.phase}', expected one of [${allowed.join(", ")}].`)
  }
}

// --- terminal reporting ----------------------------------------------------

async function writeOpenIssues(dir: string, state: any) {
  state.residual = state.open_findings.filter((f: any) => !["resolved", "accepted_risk"].includes(f.status)).map((f: any) => f.id)
  const escs: any[] = state.escalations?.length ? state.escalations : state.escalation ? [state.escalation] : []
  for (const e of escs) if (e?.status !== "acknowledged") state.residual.push(`escalation:${e.requirement_id}`)
  try {
    await fs.writeFile(path.join(designDir(dir, state.slug), "08-open-issues.md"), renderOpenIssues(state))
  } catch {
    // the run directory is gone; the state still records the residual
  }
}

// Local effects of reaching a terminal phase (report, title, toast).
async function finalizeTerminal(dir: string, state: any) {
  if (!TERMINAL.has(state.phase)) return
  // A terminal run must not carry an escalation for a finding that no longer exists.
  withdrawStaleEscalations(state)
  await writeOpenIssues(dir, state)
  await refreshTitle(dir, state)
  await notify(
    dir,
    `Crucible ${state.slug}: ${state.phase} (round ${state.round})${state.stop_reason ? ` — ${state.stop_reason}` : ""}`,
    state.phase === "converged" ? "success" : "warning",
  )
}

// Stop a run as no_progress: persist first, then let its root react.
async function failRun(dir: string, state: any, reason: string) {
  state.dispatch = null
  state.phase = "no_progress"
  state.stop_reason = reason
  await finalizeTerminal(dir, state)
  await saveState(dir, state)
  await afterRunChange(dir, state)
}

// Counters that measure the current attempt; a reopened run starts fresh.
function resetProgressCounters(state: any) {
  state.stall_count = 0
  state.dispatch_error_count = 0
  state.gate_stall_streak = 0
}

// --- UX --------------------------------------------------------------------

async function refreshTitle(dir: string, state: any) {
  if (!CLIENT || !state?.session_id) return
  try {
    const last = state.history?.[state.history.length - 1]
    const badge = last ? ` score=${last.score}` : ""
    await CLIENT.session.update({
      path: { id: state.session_id },
      body: { title: `Crucible: ${state.system} [r${state.round} ${state.phase}${badge}]` },
      query: { directory: dir },
    })
  } catch {
  }
}

async function notify(dir: string, message: string, variant: string) {
  if (!CLIENT?.tui?.showToast) return
  try {
    await CLIENT.tui.showToast({ body: { message, variant, duration: 6000 }, query: { directory: dir } })
  } catch {
  }
}

function roundSummary(state: any) {
  const h = state.history[state.history.length - 1]
  if (!h) return `r${state.round} ${state.phase}`
  return `r${h.round}: ${h.blockers} blocker, ${h.majors} major, ${h.minors} minor · gate ${h.gate} · score ${h.score}`
}

async function toastProgress(dir: string, state: any) {
  if (TERMINAL.has(state.phase)) return
  await notify(dir, `Crucible ${state.slug} · ${roundSummary(state)} · next ${state.phase}`, "info")
}

// Pending escalations, whether stored as the `escalations` set or the mirror.
function pendingEscalations(state: any): any[] {
  const escs: any[] = state.escalations?.length ? state.escalations : state.escalation ? [state.escalation] : []
  return escs.filter((e: any) => e?.status === "pending_user_ratification")
}

// The session that speaks for the user: a subsystem borrows its root's.
async function refereeSessionId(dir: string, state: any): Promise<string | null> {
  if (state?.session_id) return state.session_id
  if (state?.parent_slug) {
    const root = await readState(dir, state.parent_slug)
    return root?.session_id || null
  }
  return null
}

// Surface pending escalations: a toast plus a forced Referee turn that opens a question dialog.
async function notifyEscalations(dir: string, state: any) {
  const pending = pendingEscalations(state)
  if (!pending.length) return
  const fresh = pending.filter((e: any) => e.notified !== true)
  if (!fresh.length) return
  for (const e of fresh) e.notified = true
  const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : ""
  await notify(dir, `Crucible ${state.slug} needs you: ${fresh[0].reason}${more}`, "warning")

  const sessionId = await refereeSessionId(dir, state)
  if (!sessionId) return
  const lines = pending
    .map((e: any) => {
      const f = isFindingEscalation(e) ? (state.open_findings || []).find((x: any) => x.id === e.requirement_id) : null
      const detail = f ? `${f.severity} ${f.category}${f.status === "needs_adjudication" ? ` (${adjudicationWhy(f)})` : ""}: ${String(f.claim).slice(0, 140)}` : e.reason
      return `- [${state.slug}] ${e.requirement_id} (${f ? "finding" : "notice"}): ${detail}`
    })
    .join("\n")
  await promptReferee(
    dir,
    sessionId,
    `Crucible run '${state.slug}' has ${pending.length} item(s) needing the user's decision:\n${lines}\n\n` +
      `Call the question tool NOW — do not only describe it in text. Ask one question per item. For a finding, offer ` +
      `"Ratify as resolved", "Accept the risk", "Reopen", "Leave for now", and for each item the user decides call ` +
      `design_decide with { finding_id, decision: "resolved" | "accepted_risk" | "reopen" }. For a notice (not a finding), ` +
      `offer "Acknowledge" / "Leave for now"; acknowledging calls design_decide with { finding_id: <the id>, decision: ` +
      `"accepted_risk" } and silences it until its situation changes (it does not bypass the gate). Add slug ` +
      `"${state.slug}" if an id is ambiguous. If a ruling changes what a requirement says, amend it with design_amend_requirement. Do not revise the design yourself.`,
  )
}

// --- scheduler -------------------------------------------------------------

function dispatchPrompt(state: any, role: string, first: boolean, opts: { designDir: string; retry?: boolean; stalled?: boolean }) {
  const terminalTool = role === "architect" ? "design_respond" : "design_submit_verdict"
  const base = `Crucible ${first ? "dispatch" : "continuation"}. Run slug: ${state.slug}. Round: ${state.round}. Role: ${role}. Current revision: ${state.design_revision}. Working directory: ${opts.designDir}. Scratch directory for this run: ${runScratch(state.slug)} (also $CRUCIBLE_SCRATCH); keep evidence scripts and data there.`
  const sub = state.parent_slug
    ? ` You are subsystem '${state.namespace || state.slug}' of root run '${state.parent_slug}'; your requirement ids are namespaced and traceable to the root ledger.`
    : ""
  let blocked = ""
  if (state.acceptance_blocked_by_parent) {
    const found: any[] = state.parent_block_findings || []
    const list = found.length
      ? found.map((f: any) => `${f.id} (${f.severity}${f.category ? ` ${f.category}` : ""}): ${String(f.claim || "").slice(0, 240)}`).join("; ")
      : state.acceptance_blocked_by_parent
    blocked =
      role === "architect"
        ? ` The parent run '${state.parent_slug}' rejected this subsystem in its integration review: ${list}. Rework the design to address it specifically; your acceptance waits until you complete a round after the rejection, and the parent re-verifies the rework.`
        : ` The parent run '${state.parent_slug}' rejected this subsystem in its integration review: ${list}. Verify whether the current revision addresses it, and raise it as a finding (citing the affected requirement) if it does not.`
  }
  const intro = first
    ? "Before acting, call design_protocol to load the protocol. "
    : "This continues your existing session for this run; your prior work is in context, so do not re-read the protocol or the full artifacts unless needed. "
  const tail =
    role === "architect"
      ? `${intro}Call design_get_context({slug:"${state.slug}", role:"architect"}), then revise the design artifacts in ${opts.designDir} and call design_respond with response_json exactly as your system prompt specifies. Call the tool before ending your turn.`
      : `${intro}Call design_get_context({slug:"${state.slug}", role:"falsifier"}), then adversarially review the design in ${opts.designDir} and call design_submit_verdict with verdict_json exactly as your system prompt specifies. Call the tool before ending your turn.`
  const budget = state.budgets?.max_spec_lines
  const over = budget && (state.spec_lines || 0) > budget
  const simplify = over
    ? ` SPEC OVER BUDGET (${state.spec_lines}/${budget} lines): prefer removing or reusing mechanism over adding; use disposition "simplify" wherever possible and do not add new sections.`
    : ""
  const nudge = opts.stalled
    ? ` Your previous turn in this session ended without calling ${terminalTool}; finish the work and call ${terminalTool} before ending your turn (if it returned an error, fix what it reported and call it again).`
    : opts.retry
      ? ` Your previous attempt was interrupted; continue from where you left off and call ${terminalTool} before ending your turn.`
      : ""
  const fixes = (state.verify?.ids || []).map((id: string) => {
    const f = (state.open_findings || []).find((x: any) => x.id === id)
    return f ? `${id} (${String(f.claim || "").slice(0, 100)})` : id
  })
  const verify =
    role === "falsifier" && fixes.length
      ? ` VERIFICATION PASS: the run is ready to ${state.verify.target === "awaiting_decomposition" ? "split into subsystems" : "be accepted"}, but the Architect's round-${state.verify.round} fixes have not been checked: ${fixes.join("; ")}. Check each first and re-raise any that does not hold by its same id, citing evidence recorded this round; report anything else as usual.`
      : ""
  const integ =
    state.decompose && (state.subsystems || []).length && role === "falsifier"
      ? " The hand-off's subsystem_loose_ends lists the subsystems' unresolved and accepted findings; check each for a cross-subsystem gap the root must close (raise it with subsystem_ref if a subsystem must change)."
      : ""
  return `${base}${sub}${blocked}\n${tail}${verify}${integ}${simplify}${nudge}`
}

function armWatchdog(dir: string, slug: string, childID: string, timeout: number) {
  const now = Date.now()
  watchdogs.set(childID, { last: now, persisted: now, dir, slug, timeout, tools: new Set(), waiting: false })
  startWatchdogSweeper()
}

// Mark a dispatched child alive; cheap, since it runs on every streamed token.
function touchWatchdog(childID: string) {
  const w = watchdogs.get(childID)
  if (!w) return
  const now = Date.now()
  w.last = now
  if (now - w.persisted >= heartbeatMs()) {
    w.persisted = now
    void persistHeartbeat(w.dir, w.slug, childID)
  }
}

async function persistHeartbeat(dir: string, slug: string, childID: string) {
  try {
    await withLock(await lockForRun(dir, slug), async () => {
      const state = await readState(dir, slug)
      if (!state?.dispatch || state.dispatch.child_session_id !== childID) return
      state.dispatch.last_activity_at = nowIso()
      await saveState(dir, state)
    })
  } catch {
  }
}

// Running tool calls per dispatched child, from part updates.
function noteTool(childID: string, part: any) {
  const w = watchdogs.get(childID)
  if (!w || part?.type !== "tool" || !part.callID) return
  if (part.state?.status === "pending" || part.state?.status === "running") w.tools.add(part.callID)
  else w.tools.delete(part.callID)
}

function clearWatchdog(childID: string) {
  watchdogs.delete(childID)
  if (watchdogs.size === 0) stopWatchdogSweeper()
}

function startWatchdogSweeper() {
  if (watchdogSweeper) return
  watchdogSweeper = setInterval(() => {
    void sweepWatchdogs()
  }, watchdogSweepMs())
  // Do not keep the host process alive solely for the sweeper.
  ;(watchdogSweeper as any)?.unref?.()
}

function stopWatchdogSweeper() {
  if (!watchdogSweeper) return
  clearInterval(watchdogSweeper)
  watchdogSweeper = null
}

// Fire only for a child silent past its window.
async function sweepWatchdogs() {
  const now = Date.now()
  for (const [childID, w] of [...watchdogs]) {
    // Waiting on the user's permission is not inactivity; a running tool gets the longer window.
    if (w.waiting || now - w.last < (w.tools.size ? Math.max(w.timeout, TOOL_WATCHDOG_MS) : w.timeout)) continue
    watchdogs.delete(childID)
    try {
      void withLock(await lockForRun(w.dir, w.slug), async () => {
        const state = await readState(w.dir, w.slug)
        if (!state || !state.dispatch || state.dispatch.child_session_id !== childID) return
        await retryOrFail(w.dir, state, state.dispatch, "watchdog_timeout")
      }).catch(() => {})
    } catch {
    }
  }
  if (watchdogs.size === 0) stopWatchdogSweeper()
}

// Kill this user's processes whose environment has the marker (catches detached daemons); SIGTERM, then SIGKILL after 2s.
// This user's processes whose environment carries the marker (Linux /proc, macOS ps; elsewhere none).
function markedPids(marker: string): number[] {
  const pids: number[] = []
  try {
    if (process.platform === "linux") {
      for (const n of readdirSync("/proc")) {
        if (!/^\d+$/.test(n) || +n === process.pid) continue
        try {
          if (readFileSync(`/proc/${n}/environ`, "utf8").split("\0").includes(marker)) pids.push(+n)
        } catch {
        }
      }
    } else if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-E", "-ww", "-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
      for (const line of out.split("\n")) {
        const pid = parseInt(line.trim(), 10)
        if (pid && pid !== process.pid && line.split(/\s+/).includes(marker)) pids.push(pid)
      }
    }
  } catch {
  }
  return pids
}

// Containers are started by the daemon and never carry the env marker; remove them by the label the bash hook injects.
function removeLabelledContainers(key: string, value: string) {
  for (const bin of ["docker", "podman"]) {
    try {
      const ids = execFileSync(bin, ["ps", "-aq", "--filter", `label=${key}=${value}`], { timeout: 10000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\s+/).filter(Boolean)
      if (ids.length) execFileSync(bin, ["rm", "-f", ...ids], { timeout: 10000, stdio: "ignore" })
    } catch {
    }
  }
}

// Terminate an agent's leftover processes; survivors are re-found (never a reused pid) and killed after 2s.
function killMarked(marker: string) {
  const m = marker.match(/^CRUCIBLE_(SESSION|WORKTREE)=(.*)$/s)
  if (m) removeLabelledContainers(`crucible.${m[1].toLowerCase()}`, m[2])
  const send = (pids: number[], sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig)
      } catch {
      }
    }
  }
  const pids = markedPids(marker)
  if (!pids.length) return
  send(pids, "SIGTERM")
  setTimeout(() => send(markedPids(marker), "SIGKILL"), 2000).unref?.()
}

async function abortSession(dir: string, id: string) {
  clearWatchdog(id)
  killMarked(`CRUCIBLE_SESSION=${id}`)
  try {
    await CLIENT?.session?.abort?.({ path: { id }, query: { directory: dir } })
  } catch {
  }
}

// Abort dispatched child sessions when the run is stopped or paused.
async function abortSessions(dir: string, state: any, onlyCurrent = false) {
  const ids: string[] = onlyCurrent ? [state.dispatch?.child_session_id].filter(Boolean) : state.managed_sessions || []
  for (const id of ids) await abortSession(dir, id)
  // Stopping a root stops the whole effort: abort its subsystems' sessions too.
  if (!onlyCurrent && state.decompose) {
    for (const sub of state.subsystems || []) {
      const child = await readState(dir, childSlug(state, sub))
      if (!child) continue
      for (const id of child.managed_sessions || []) await abortSession(dir, id)
    }
  }
}

// One retry per role, then give up with a terminal reason.
async function retryOrFail(dir: string, state: any, dispatch: any, reason: string) {
  // A paused or terminal run must never be re-dispatched or downgraded.
  if (TERMINAL.has(state.phase) || state.paused) {
    state.dispatch = null
    await saveState(dir, state)
    return
  }
  if ((dispatch?.retries || 0) < 1) {
    const childID = dispatch?.child_session_id
    state.dispatch = null
    await saveState(dir, state)
    // Stop the hung turn before re-prompting the same session.
    if (childID) await abortSession(dir, childID)
    const retries = (dispatch.retries || 0) + 1
    try {
      await dispatchRole(dir, state, dispatch.role, retries)
    } catch {
      // dispatchRole dropped a dead session; one more attempt gets a fresh one.
      try {
        await dispatchRole(dir, state, dispatch.role, retries)
      } catch (error: any) {
        await failRun(dir, state, `${reason}; retry failed: ${error?.message || String(error)}`)
      }
    }
    return
  }
  await failRun(dir, state, reason)
}

function parseModelRef(ref: any) {
  const v = String(ref ?? "").trim()
  const i = v.indexOf("/")
  if (i <= 0 || i === v.length - 1 || /\s/.test(v)) return null
  return { providerID: v.slice(0, i), modelID: v.slice(i + 1) }
}

// "inherit" (or empty/default) clears a per-role model override.
function isInheritModel(ref: any) {
  return /^(|inherit|default|none)$/i.test(String(ref ?? "").trim())
}

async function dispatchRole(dir: string, state: any, role: string, retries = 0) {
  // One long-lived child session per role per run, kept separate to preserve independence.
  state.sessions = state.sessions || {}
  let childID: string | undefined = state.sessions[role]
  const first = !childID
  if (!childID) {
    const parentID = await refereeSessionId(dir, state)
    const created = await CLIENT.session.create({
      body: { ...(parentID ? { parentID } : {}), title: `crucible:${state.slug}:${role}`, permission: sessionPermissions(effectiveShellPolicy(state)) },
      query: { directory: dir },
    })
    // The SDK reports HTTP failures in the result instead of throwing.
    if (created?.error) throw new Error(`Failed to create child session: ${errorText(created.error)}`)
    const child = created?.data ?? created
    childID = child?.id
    if (!childID) throw new Error("Failed to create child session for dispatch.")
    state.sessions[role] = childID
    await bindSession(dir, childID, state.slug)
    state.managed_sessions = state.managed_sessions || []
    if (!state.managed_sessions.includes(childID)) state.managed_sessions.push(childID)
    state.session_policy = { ...(state.session_policy || {}), [role]: effectiveShellPolicy(state) }
  }
  // A reused session gets the current policy's rules (later rules win in opencode).
  const policy = effectiveShellPolicy(state)
  if (state.session_policy?.[role] !== policy) {
    try {
      await CLIENT.session.update({ path: { id: childID }, body: { permission: sessionPermissions(policy) }, query: { directory: dir } })
      state.session_policy = { ...(state.session_policy || {}), [role]: policy }
    } catch {
    }
  }
  await fs.mkdir(runScratch(state.slug), { recursive: true }).catch(() => {})
  const stalled = (state.stall_count || 0) > 0
  state.dispatch = {
    attempt_id: `${state.slug}-${Date.now()}`,
    role,
    agent: role,
    child_session_id: childID,
    round: state.round,
    phase: state.phase,
    revision: state.design_revision,
    retries,
    started: false,
    started_at: nowIso(),
  }
  await saveState(dir, state)
  armWatchdog(dir, state.slug, childID as string, effectiveWatchdogMs(state))
  await refreshTitle(dir, state)
  try {
    const model = parseModelRef(state.models?.[role])
    const res = await CLIENT.session.promptAsync({
      path: { id: childID },
      body: {
        agent: role,
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: dispatchPrompt(state, role, first, { designDir: relDesignDir(dir, state.slug), retry: retries > 0, stalled }) }],
      },
      query: { directory: dir },
    })
    if (res?.error) throw new Error(`promptAsync failed: ${errorText(res.error)}`)
  } catch (error) {
    // The reused session may be gone; drop it so the retry recreates it.
    delete state.sessions[role]
    state.managed_sessions = (state.managed_sessions || []).filter((id: string) => id !== childID)
    await saveState(dir, state)
    if (childID) await abortSession(dir, childID)
    throw error
  }
  state.dispatch_error_count = 0
  await saveState(dir, state)
}

async function advance(dir: string, slug: string, allowRetry = true) {
  const key = lockKey(dir, slug)
  if (advancing.has(key)) return
  advancing.add(key)
  try {
    const state = await readState(dir, slug)
    if (!state) return
    if (TERMINAL.has(state.phase) || state.paused) return
    if (state.dispatch) return
    if (state.phase === "eliciting" || state.phase === "awaiting_confirmation" || state.phase === "awaiting_decomposition") return
    if (state.decompose) {
      // Gate on the subsystems as they are on disk, not a possibly stale summary.
      if ((state.subsystems || []).length) {
        state.children = await buildChildren(dir, state)
        state.waiting_on = waitingOn(state)
      }
      const gate = childrenGate(state)
      if (gate === "failed") {
        state.phase = "blocked"
        state.stop_reason = "required subsystem failed or rejected"
        await finalizeTerminal(dir, state)
        await saveState(dir, state)
        return
      }
      if (gate === "waiting") return
    }

    let role: string
    if (state.phase === "designing") {
      if (state.design_revision === "v0") {
        role = "architect"
      } else {
        beginRound(state)
        role = "falsifier"
      }
    } else if (state.phase === "falsifying") {
      role = "falsifier"
    } else if (state.phase === "responding") {
      role = "architect"
    } else {
      return
    }
    await saveState(dir, state)
    await dispatchRole(dir, state, role)
  } catch (e: any) {
    const state = await readState(dir, slug)
    if (!state) return
    // Do not turn a run the user paused or that already finished into a failure.
    if (TERMINAL.has(state.phase) || state.paused) {
      state.dispatch = null
      await saveState(dir, state)
      return
    }
    state.dispatch = null
    const count = (state.dispatch_error_count || 0) + 1
    state.dispatch_error_count = count
    await saveState(dir, state)
    if (allowRetry && count <= 1) {
      advancing.delete(key)
      await advance(dir, slug, false)
      return
    }
    await failRun(dir, state, `dispatch_error: ${e?.message || String(e)}`)
  } finally {
    advancing.delete(key)
  }
}

// Start a root's subsystem runs in dependency order, up to the parallelism cap.
async function pumpChildren(dir: string, rootSlug: string) {
  const root = await readState(dir, rootSlug)
  if (!root || !root.decompose) return
  // A terminal or paused root must never (re)start subsystems.
  if (TERMINAL.has(root.phase) || root.paused) return
  root.children = await buildChildren(dir, root)
  root.waiting_on = waitingOn(root)
  await applyRootGuards(dir, root)
  await saveState(dir, root)
  // A failed children gate blocks the root immediately.
  const gate = childrenGate(root)
  if (gate === "failed") {
    await advance(dir, rootSlug)
    return
  }
  const cap = Number(root.max_parallel) > 0 ? Number(root.max_parallel) : 1
  const required = effectiveRequired(root)
  const acceptedName = (name: string) => {
    const c = root.children.find((x: any) => x.name === name)
    return !!c && isAcceptedTerminal(c.phase)
  }
  const states = new Map<string, any>()
  for (const c of root.children) states.set(c.slug, await readState(dir, c.slug))
  const inProgress = (st: any) =>
    !!st && !TERMINAL.has(st.phase) && !st.paused && (!!st.dispatch || st.round > 0 || st.design_revision !== "v0")
  let active = 0
  for (const c of root.children) {
    const st = states.get(c.slug)
    if (!inProgress(st)) continue
    active += 1
    if (!st.dispatch) await advance(dir, c.slug)
  }
  const candidates = [...root.children]
    .sort((a: any, b: any) => Number(required.has(b.name)) - Number(required.has(a.name)))
    .filter((c: any) => {
      const st = states.get(c.slug)
      return !!st && !inProgress(st) && !TERMINAL.has(st.phase) && !st.paused && !st.dispatch && (c.depends_on || []).every(acceptedName)
    })
  for (const c of candidates.slice(0, Math.max(0, cap - active))) await advance(dir, c.slug)
  // Re-arm the root once its children are all accepted (integration round).
  if (gate === "ready") await advance(dir, rootSlug)
}

// A dispatched turn begins with a busy status; record it so a later idle is trusted.
async function onBusy(dir: string, childID: string) {
  const slug = await resolveSlug(dir, undefined, childID)
  if (!slug) return
  await withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state || !state.dispatch || state.dispatch.child_session_id !== childID) return
    if (state.dispatch.started !== true) {
      state.dispatch.started = true
      await saveState(dir, state)
    }
  })
}

async function onIdle(dir: string, childID: string) {
  const slug = await resolveSlug(dir, undefined, childID)
  if (!slug) return
  await withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state) return
    const d = state.dispatch
    if (!d || d.child_session_id !== childID) return
    const advanced = state.phase !== d.phase || state.design_revision !== d.revision
    const started = d.started === true
    const age = Date.now() - (Date.parse(d.started_at || "") || 0)
    // Ignore an idle that arrives before the turn began (spurious or compaction).
    if (!advanced && !started && age < BUSY_GRACE_MS) return
    // A compaction idle arrives mid-turn; do not treat it as the turn finishing.
    if (!advanced && Date.now() - (lastCompacted.get(childID) || 0) < BUSY_GRACE_MS) return
    lastCompacted.delete(childID)
    clearWatchdog(childID)
    killMarked(`CRUCIBLE_SESSION=${childID}`)
    state.dispatch = null
    state.dispatch_error_count = 0
    if (advanced) state.stall_count = 0
    else state.stall_count = (state.stall_count || 0) + 1
    await saveState(dir, state)

    if (TERMINAL.has(state.phase) || state.paused) return
    if (!advanced && state.stall_count >= 2) {
      await failRun(dir, state, "dispatch_stalled")
      return
    }
    await advance(dir, slug)
  })
}

async function onSessionError(dir: string, childID: string, error: any) {
  // Aborts (watchdog retry, pause, stop, or the user's) are not a failure of the turn.
  if (error?.name === "MessageAbortedError") return
  const slug = await resolveSlug(dir, undefined, childID)
  if (!slug) return
  await withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state || !state.dispatch || state.dispatch.child_session_id !== childID) return
    clearWatchdog(childID)
    await retryOrFail(dir, state, state.dispatch, `session_error${error?.name ? `: ${error.name}` : ""}`)
  })
}

// A managed child session was deleted; forget it and re-drive any in-flight turn.
async function onSessionDeleted(dir: string, sessionID: string) {
  shellRuns.delete(sessionID)
  const slug = await resolveSlug(dir, undefined, sessionID)
  if (!slug) return
  await withLock(await lockForRun(dir, slug), async () => {
    const state = await readState(dir, slug)
    if (!state || !(state.managed_sessions || []).includes(sessionID)) return
    clearWatchdog(sessionID)
    killMarked(`CRUCIBLE_SESSION=${sessionID}`)
    for (const [role, id] of Object.entries(state.sessions || {})) if (id === sessionID) delete state.sessions[role]
    state.managed_sessions = state.managed_sessions.filter((id: string) => id !== sessionID)
    if (state.dispatch?.child_session_id === sessionID) {
      await retryOrFail(dir, state, state.dispatch, "session_deleted")
      return
    }
    await saveState(dir, state)
  })
}

// Sessions the server reports as running (busy/retry), or null if it cannot say.
async function busySessions(dir: string): Promise<Set<string> | null> {
  if (!CLIENT?.session?.status) return null
  try {
    const res = await CLIENT.session.status({ query: { directory: dir } })
    if (res?.error) return null
    const map = res?.data ?? res
    if (!map || typeof map !== "object") return null
    return new Set(
      Object.entries(map)
        .filter(([, s]: [string, any]) => s && typeof s === "object" && s.type && s.type !== "idle")
        .map(([id]) => id),
    )
  } catch {
    return null
  }
}

// Recover this worktree's runs left with an in-flight dispatch after a reload/crash.
async function recoverRuns(dir: string) {
  const runs = await registryRuns(dir)
  const busy = await busySessions(dir)
  for (const { slug } of runs) {
    try {
      await withLock(await lockForRun(dir, slug), async () => {
        const state = await readState(dir, slug)
        if (!state || !state.dispatch) return
        // A child of a terminal root must not be revived by recovery.
        if (state.parent_slug) {
          const root = await readState(dir, state.parent_slug)
          if (root && TERMINAL.has(root.phase)) {
            state.dispatch = null
            if (!TERMINAL.has(state.phase)) {
              state.stopped_from = state.phase
              state.phase = "stopped"
              state.stop_reason = "parent_terminal"
            }
            await saveState(dir, state)
            return
          }
        }
        if (TERMINAL.has(state.phase)) {
          state.dispatch = null
          await saveState(dir, state)
          return
        }
        const d = state.dispatch
        const started = Date.parse(d.started_at || "") || 0
        const age = started ? Date.now() - started : Number.POSITIVE_INFINITY
        const window = effectiveWatchdogMs(state)
        // A turn is alive only if its session is still running.
        const alive = !!d.child_session_id && (busy ? busy.has(d.child_session_id) : age <= window)
        if (alive) {
          armWatchdog(dir, slug, d.child_session_id, window)
          return
        }
        // A turn that did finish its work before the restart is not a stall.
        const advanced = state.phase !== d.phase || state.design_revision !== d.revision
        state.dispatch = null
        state.stall_count = advanced ? 0 : (state.stall_count || 0) + 1
        if (state.stall_count > 3) {
          await failRun(dir, state, "recovered_stale_dispatch")
          return
        }
        await saveState(dir, state)
        await advance(dir, slug)
      })
    } catch {
    }
  }
  // Re-pump decompose roots so a crash between child creation and dispatch heals.
  for (const { slug } of runs) {
    try {
      const st = await readState(dir, slug)
      if (st?.decompose && (st.subsystems || []).length) {
        await withLock(await lockForRun(dir, slug), () => pumpChildren(dir, slug))
      }
    } catch {
    }
  }
  // Re-surface decomposition holds and pending escalations after a restart.
  for (const { slug } of runs) {
    try {
      await withLock(await lockForRun(dir, slug), async () => {
        const st = await readState(dir, slug)
        if (!st || st.paused || TERMINAL.has(st.phase)) return
        if (st.phase === "awaiting_decomposition" && st.decomposition_ready) {
          await promptReferee(
            dir,
            st.session_id,
            `Crucible run '${st.slug}' is holding in awaiting_decomposition with a valid ${relDesignDir(dir, st.slug)}/decomposition.json. Read it and call the \`question\` tool NOW (Approve / Edit / Cancel) before calling design_decompose with { slug: "${st.slug}" }.`,
          )
        }
        // Drop escalations whose finding no longer exists before re-surfacing.
        withdrawStaleEscalations(st)
        const pending = pendingEscalations(st)
        if (pending.length) {
          for (const e of pending) e.notified = false
          await notifyEscalations(dir, st)
        }
        await saveState(dir, st)
      })
    } catch {
    }
  }
}

// --- child-agent guards ----------------------------------------------------

// Paths a file-writing tool call will touch (edit/write/multiedit and patch headers).
function writtenPaths(toolName: string, args: any): string[] {
  if (!args || typeof args !== "object") return []
  if (/todo/.test(toolName) || !/(edit|write|patch)/.test(toolName)) return []
  const out: string[] = []
  for (const key of ["filePath", "file_path", "path"]) if (typeof args[key] === "string" && args[key]) out.push(args[key])
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue
    for (const m of value.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) out.push(m[1].trim())
  }
  return out
}

// opencode's own temp dir (Global.Path.tmp): the agents' scratch area, allowed for writes and outside-directory access.
const SCRATCH_DIR = path.join(os.tmpdir(), "opencode")
const runScratch = (slug: string) => path.join(SCRATCH_DIR, "crucible", slug)
// Where opencode stores full outputs of truncated tool results, which agents must be able to read.
const TOOL_OUTPUT_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "tool-output")

// Child-session permission rules for a shell policy. Unattended policies never leave an "ask": nobody could answer it.
function sessionPermissions(policy: string) {
  const prompt = policy === "ask"
  const outside = policy === "allow" ? "allow" : prompt ? "ask" : "deny"
  return [
    { permission: "bash", pattern: "*", action: prompt ? "ask" : "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: outside },
    { permission: "external_directory", pattern: path.join(SCRATCH_DIR, "*"), action: "allow" },
    { permission: "external_directory", pattern: path.join(TOOL_OUTPUT_DIR, "*"), action: "allow" },
    { permission: "doom_loop", pattern: "*", action: prompt ? "ask" : "deny" },
    { permission: "read", pattern: "*.env", action: prompt ? "ask" : "deny" },
    { permission: "read", pattern: "*.env.*", action: prompt ? "ask" : "deny" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
  ]
}

// A prompt raised in a dispatched session: unattended runs reject it at once; "ask" runs wait for the user.
async function onPermissionAsked(dir: string, p: any) {
  const sid = p?.sessionID
  if (!sid || !p?.id) return
  const caller = await callerRun(dir, sid)
  if (!caller) return
  const what = `${p.permission} ${[p.patterns].flat().filter(Boolean).join(" ")}`.trim()
  if (effectiveShellPolicy(caller.state) === "ask") {
    const w = watchdogs.get(sid)
    if (w) w.waiting = true
    await notify(dir, `Crucible ${caller.slug}: the ${caller.role || "agent"} is waiting for your permission (${what})`, "warning")
    return
  }
  // A rejection with feedback lets the agent continue its turn; a bare one (the fallback) ends it.
  const feedback = `Refused automatically: this unattended run allows no ${p.permission} prompts. ${p.permission === "external_directory" ? `Work inside the project or ${SCRATCH_DIR} instead.` : "Take another route."} Continue your task.`
  const replied = await fetch(new URL(`/permission/${p.id}/reply?directory=${encodeURIComponent(dir)}`, SERVER_URL || "http://invalid"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject", message: feedback }),
  }).then((r) => r.ok, () => false)
  if (!replied) {
    try {
      await CLIENT?.postSessionIdPermissionsPermissionId?.({ path: { id: sid, permissionID: p.id }, body: { response: "reject" }, query: { directory: dir } })
    } catch {
    }
  }
  await notify(dir, `Crucible ${caller.slug}: rejected a ${what} prompt for the ${caller.role || "agent"} (unattended run)`, "info")
}

// Protocol hard rules for files: state only via design_* tools, writes only inside the run dir.
function fileGuard(dir: string, caller: { slug: string; role: string | null }, file: string): string | null {
  const abs = path.resolve(dir, file)
  if (withinDir(abs, SCRATCH_DIR)) return null
  const runDir = designDir(dir, caller.slug)
  if (!withinDir(abs, runDir)) return `the ${caller.role || "agent"} of run '${caller.slug}' may only write inside its own run directory (${relDesignDir(dir, caller.slug)}) or ${SCRATCH_DIR}.`
  if (path.relative(runDir, abs).split(path.sep).includes(".crucible")) return "run state under .crucible/ is written only by the design_* tools."
  const name = path.relative(runDir, abs).split(path.sep).join("/")
  if (caller.role === "falsifier" && ((/\.md$/i.test(name) && name !== "07-review-log.md") || name === "decomposition.json")) {
    return "the Falsifier never edits design artifacts; it writes only 07-review-log.md (submit findings with design_submit_verdict)."
  }
  if (caller.role === "architect" && ["00-brief.md", "01-requirements.md", "07-review-log.md", "08-open-issues.md"].includes(name)) {
    return `${name} is owned by the ${name === "07-review-log.md" ? "Falsifier" : "plugin"}; the Architect edits the design artifacts only.`
  }
  return null
}

// --- tools -----------------------------------------------------------------

// Configuration knobs shared by design_start and design_config (chosen per run).
const CONFIG_ARGS = {
  preset: z.enum(["fast", "standard", "deep", "exhaustive"]).optional().describe("Effort preset."),
  mode: z.enum(["fast", "standard", "deep"]).optional().describe("Budget mode (alias of preset)."),
  max_rounds: z.number().int().positive().optional().describe("Round budget (for a decompose root, per phase: before and after decomposition)."),
  max_spec_lines: z.number().int().positive().optional().describe("Design spec-size budget in lines."),
  k: z.number().int().positive().optional().describe("Clean rounds required for convergence."),
  m: z.number().int().positive().optional().describe("Rounds of no gate decrease before no_progress."),
  majors_threshold: z.number().int().min(0).optional().describe("Validated majors allowed at acceptance."),
  max_parallel: z.number().int().positive().optional().describe("Max concurrent subsystems (decompose)."),
  watchdog_ms: z.number().int().positive().optional().describe("Inactivity window for a dispatched agent turn, in ms (default 600000; at least 30 min while a tool call runs): a turn is retried only after this much silence, never for taking long."),
  architect_model: z.string().optional().describe('provider/model for the Architect ("inherit" clears the override).'),
  falsifier_model: z.string().optional().describe('provider/model for the Falsifier ("inherit" clears the override).'),
  shell_policy: z.enum(["guarded", "allow", "ask"]).optional().describe("Child-agent shell policy: guarded (no prompts; outside directories denied except the scratch dir; repeated calls and .env reads denied; a blocklist refuses destructive, remote-affecting, and repository-changing git commands; not a sandbox, so commit first), ask (opencode prompts the user), allow (like guarded, but outside directories allowed)."),
  strict: z.boolean().optional().describe("Disallow accepted_with_reservations (converged only)."),
  decompose: z.boolean().optional().describe("Make this a root run that decomposes into subsystems."),
  decomposition: z.enum(["auto", "confirm"]).optional().describe("When the Architect writes decomposition.json: confirm (ask the user) or auto (ingest without asking)."),
  domains: z.array(z.string()).optional().describe("Restrict coverage/gating to these dimensions."),
}

// Validate then apply the configuration arguments; nothing is applied when there are problems.
function applyConfig(state: any, args: any) {
  const problems: string[] = []
  const warnings: string[] = []
  for (const role of ["architect", "falsifier"]) {
    const ref = args[`${role}_model`]
    if (ref != null && !isInheritModel(ref) && !parseModelRef(ref)) problems.push(`${role}_model '${ref}' must be "provider/model" (or "inherit" to clear it)`)
  }
  if (args.decompose === true && state.parent_slug) problems.push("a subsystem run cannot decompose")
  if (args.decompose === false && (state.subsystems || []).length) problems.push("this run already has subsystems; decompose cannot be turned off")
  if (problems.length) return { problems, warnings }

  state.models = state.models || {}
  if (args.preset) {
    state.preset = args.preset
    state.budgets = presetBudgets(args.preset)
  } else if (args.mode) {
    state.preset = args.mode
    state.budgets = budgetsFor(args.mode)
  }
  if (args.max_rounds) state.budgets.max_rounds = args.max_rounds
  if (args.max_spec_lines) state.budgets.max_spec_lines = args.max_spec_lines
  if (args.k) state.budgets.k = args.k
  if (args.m) state.budgets.m = args.m
  if (args.majors_threshold != null) state.budgets.majors_threshold = args.majors_threshold
  if (args.max_parallel) state.max_parallel = args.max_parallel
  if (args.watchdog_ms) state.watchdog_ms = args.watchdog_ms
  if (args.decompose != null) state.decompose = args.decompose
  if (args.decomposition) state.decomposition_mode = args.decomposition
  if (args.domains) {
    const valid = new Set(REQUIRED_DIMENSIONS)
    const dropped = args.domains.filter((d: string) => !valid.has(d))
    state.domains = args.domains.filter((d: string) => valid.has(d))
    if (dropped.length) warnings.push(`unknown domains ignored: ${dropped.join(", ")}${state.domains.length ? "" : " (coverage spans all dimensions)"}`)
    // Coverage gaps are measured against the (new) domains.
    refreshCoverage(state)
  }
  for (const role of ["architect", "falsifier"]) {
    const ref = args[`${role}_model`]
    if (ref == null) continue
    if (isInheritModel(ref)) delete state.models[role]
    else state.models[role] = String(ref).trim()
  }
  if (args.shell_policy) state.shellPolicy = args.shell_policy
  if (args.strict === true) state.allowAccepted = false
  if (args.strict === false) state.allowAccepted = true
  return { problems, warnings }
}

function seedRequirements(state: any, reqs: any[]) {
  const prefix = state.namespace ? `${state.namespace}-R-` : "R-"
  for (const r of reqs || []) {
    if (!r?.text) continue
    state.requirements.items.push({
      id: nextId(state, prefix, state.requirements.items),
      text: r.text,
      priority: r.priority || "must",
      acceptance: r.acceptance || "",
      status: "open",
    })
  }
}

function configOf(state: any) {
  return {
    preset: state.preset || state.budgets?.mode || "fast",
    budgets: state.budgets,
    decompose: state.decompose === true,
    decomposition: state.decomposition_mode || "confirm",
    domains: state.domains || [],
    max_parallel: state.max_parallel ?? null,
    watchdog_ms: state.watchdog_ms ?? effectiveWatchdogMs(state),
    models: state.models || {},
    shellPolicy: effectiveShellPolicy(state),
    strict: state.allowAccepted === false,
  }
}

const REFEREE_ONLY: string[] = []

const DESIGN_START = tool({
  description: "Start a Crucible adversarial design run. Creates the run directory, writes the brief, and opens the requirement ledger. Run settings are per-run.",
  args: {
    system: z.string().describe("Short name of the system to design."),
    brief: z.string().describe("The system brief: problem, goals, non-goals, stakeholders, scope boundary."),
    slug: z.string().optional().describe("Run slug; derived from the system name if omitted."),
    requirements: z
      .array(
        z.object({
          text: z.string(),
          priority: z.enum(["must", "should", "could", "wont"]).optional(),
          acceptance: z.string().optional(),
        }),
      )
      .optional()
      .describe("Optional seeded requirement ledger (e.g. a must-only seed drafted from the brief)."),
    ...CONFIG_ARGS,
  },
  async execute(args, ctx) {
    await assertCaller(ctx.directory, ctx.sessionID, "design_start", REFEREE_ONLY)
    if (!String(args.brief || "").trim()) return JSON.stringify({ ok: false, error: "A non-empty brief is required." }, null, 2)
    const slug = args.slug ? slugify(args.slug) : slugify(args.system)
    return withLock(lockKey(ctx.directory, "@effort:" + slug), async () => {
      const existing = await readState(ctx.directory, slug)
      if (existing) return JSON.stringify({ ok: false, error: `Run '${slug}' already exists.`, status: summarize(existing) }, null, 2)
      const state = newState(slug, args.system, ctx.sessionID, args.preset || args.mode)
      const { problems, warnings } = applyConfig(state, args)
      if (problems.length) return JSON.stringify({ ok: false, error: problems[0], problems }, null, 2)
      seedRequirements(state, args.requirements || [])
      const dir = designDir(ctx.directory, slug)
      await fs.mkdir(path.join(dir, ".crucible", "verdicts"), { recursive: true })
      await fs.mkdir(path.join(dir, ".crucible", "responses"), { recursive: true })
      await fs.mkdir(path.join(dir, ".crucible", "evidence"), { recursive: true })
      await fs.writeFile(path.join(dir, "00-brief.md"), `# Brief: ${args.system}\n\n${args.brief}\n`)
      await writeRequirements(ctx.directory, state)
      await saveState(ctx.directory, state)
      await bindSession(ctx.directory, ctx.sessionID, slug)
      const others = (await boundRunsIn(ctx.directory, ctx.sessionID)).filter((r: any) => r.slug !== slug)
      const active: string[] = []
      for (const r of others) {
        const st = await readState(ctx.directory, r.slug)
        if (st && !TERMINAL.has(st.phase)) active.push(r.slug)
      }
      const warning = active.length
        ? `Other active runs in this session: ${active.join(", ")}. Pass an explicit slug to address them.`
        : undefined
      return JSON.stringify({ ok: true, warning, warnings: warnings.length ? warnings : undefined, config: configOf(state), status: summarize(state) }, null, 2)
    })
  },
})

const DESIGN_CONFIG = tool({
  description: "Show (and optionally update) a run's configuration: preset, budgets, models, shell policy, strictness, decomposition. Non-terminal runs only for updates.",
  args: { slug: z.string().optional(), ...CONFIG_ARGS },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        const updates = Object.keys(CONFIG_ARGS).some((k) => (args as any)[k] != null)
        if (!updates) return JSON.stringify({ ok: true, updated: false, config: configOf(state) }, null, 2)
        if (TERMINAL.has(state.phase)) return JSON.stringify({ ok: false, error: `Run is terminal (${state.phase}); configuration is frozen.`, config: configOf(state) }, null, 2)
        const { problems, warnings } = applyConfig(state, args)
        if (problems.length) return JSON.stringify({ ok: false, error: problems[0], problems, config: configOf(state) }, null, 2)
        // A new inactivity window applies to the turn already in flight.
        const live = state.dispatch?.child_session_id ? watchdogs.get(state.dispatch.child_session_id) : null
        if (live && args.watchdog_ms) live.timeout = effectiveWatchdogMs(state)
        await saveState(ctx.directory, state)
        // A larger parallelism cap can start waiting subsystems now.
        if (args.max_parallel && (state.subsystems || []).length) await pumpChildren(ctx.directory, slug)
        const after = (await readState(ctx.directory, slug)) || state
        return JSON.stringify({ ok: true, updated: true, warnings: warnings.length ? warnings : undefined, config: configOf(after) }, null, 2)
      },
      { tool: "design_config", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_ADD_REQUIREMENT = tool({
  description: "Add a requirement to the run's requirement ledger. After confirmation this is an amendment: the ledger version is bumped and it stays frozen.",
  args: {
    slug: z.string().optional(),
    text: z.string().describe("Requirement statement."),
    priority: z.enum(["must", "should", "could", "wont"]).describe("MoSCoW priority."),
    acceptance: z.string().optional().describe("Acceptance criteria."),
    id: z.string().optional().describe("Stable id (R-###, or <NS>-R-### on a subsystem); auto-assigned if omitted."),
    system_reqs: z.array(z.string()).optional().describe("Root must/should requirement ids this item satisfies (subsystem runs only)."),
  },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        assertPhase(state, ["eliciting", "awaiting_confirmation", "designing", "awaiting_decomposition"])
        const prefix = state.namespace ? `${state.namespace}-R-` : "R-"
        const id = args.id ? String(args.id).trim() : nextId(state, prefix, state.requirements.items)
        if (state.namespace && !id.startsWith(prefix)) return JSON.stringify({ ok: false, error: `Requirement id '${id}' must start with '${prefix}'.` }, null, 2)
        if (state.requirements.items.some((r: any) => r.id === id)) {
          return JSON.stringify({ ok: false, error: `Requirement id '${id}' already exists.` }, null, 2)
        }
        const systemReqs: string[] = args.system_reqs || []
        if (systemReqs.length) {
          if (!state.parent_slug) return JSON.stringify({ ok: false, error: "system_reqs apply only to a subsystem run." }, null, 2)
          const root = await readState(ctx.directory, state.parent_slug)
          const allowed = new Set<string>((root?.requirements?.items || []).filter((r: any) => r.priority === "must" || r.priority === "should").map((r: any) => r.id))
          const bad = systemReqs.filter((r) => !allowed.has(r))
          if (bad.length) return JSON.stringify({ ok: false, error: `system_reqs must cite must/should requirements of '${state.parent_slug}': ${bad.join(", ")}` }, null, 2)
        }
        // Amending a confirmed ledger bumps its version and keeps it frozen.
        if (state.requirements.frozen) state.requirements.version += 1
        const item: any = { id, text: args.text, priority: args.priority, acceptance: args.acceptance || "", status: "open" }
        if (systemReqs.length) item.system_reqs = systemReqs
        else if (state.namespace) item.traced = false
        state.requirements.items.push(item)
        await writeRequirements(ctx.directory, state)
        if (state.parent_slug && systemReqs.length) await mergeRootTraceability(ctx.directory, state, item)
        await saveState(ctx.directory, state)
        // The root's traceability guard reads the subsystem's ledger.
        await afterRunChange(ctx.directory, state)
        return JSON.stringify({ ok: true, id, status: summarize(state) }, null, 2)
      },
      { tool: "design_add_requirement", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_AMEND_REQUIREMENT = tool({
  description: "Amend an existing requirement (text, priority and/or acceptance) after a ruling changes what it says. Bumps the ledger version if frozen and keeps the old values in the item's amended history.",
  args: {
    slug: z.string().optional(),
    id: z.string().describe("Existing requirement id."),
    text: z.string().optional().describe("New requirement statement."),
    priority: z.enum(["must", "should", "could", "wont"]).optional().describe("New MoSCoW priority."),
    acceptance: z.string().optional().describe("New acceptance criteria."),
    reason: z.string().describe("Why, e.g. 'user ruling on F-006'."),
  },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        // Rulings land mid-round, so an amendment is legal in any live phase.
        if (TERMINAL.has(state.phase)) return JSON.stringify({ ok: false, error: `Run is terminal (${state.phase}); the ledger is closed.` }, null, 2)
        const item = state.requirements.items.find((r: any) => r.id === args.id)
        if (!item) return JSON.stringify({ ok: false, error: `Unknown requirement id '${args.id}'.` }, null, 2)
        const fields = ["text", "priority", "acceptance"].filter((k) => (args as any)[k] !== undefined && (args as any)[k] !== item[k])
        if (!fields.length) return JSON.stringify({ ok: false, error: "Nothing to change: give a different text, priority or acceptance." }, null, 2)
        if (state.requirements.frozen) state.requirements.version += 1
        const before = { text: item.text, priority: item.priority, acceptance: item.acceptance }
        for (const k of fields) item[k] = (args as any)[k]
        item.amended = [...(item.amended || []), { version: state.requirements.version, at: nowIso(), reason: args.reason, before }]
        await writeRequirements(ctx.directory, state)
        await saveState(ctx.directory, state)
        await afterRunChange(ctx.directory, state)
        return JSON.stringify({ ok: true, id: item.id, status: summarize(state) }, null, 2)
      },
      { tool: "design_amend_requirement", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_CONFIRM_REQUIREMENTS = tool({
  description: "Freeze the requirement ledger (with a version) and move the run to the design phase.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        assertPhase(state, ["eliciting", "awaiting_confirmation"])
        if (state.requirements.items.length === 0) return JSON.stringify({ ok: false, error: "No requirements to confirm." }, null, 2)
        state.requirements.frozen = true
        state.phase = "designing"
        await writeRequirements(ctx.directory, state)
        await saveState(ctx.directory, state)
        return JSON.stringify({ ok: true, status: summarize(state) }, null, 2)
      },
      { tool: "design_confirm_requirements", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_BEGIN_ROUND = tool({
  description: "Referee-only: begin a review round. Moves the run to the falsify phase so the Falsifier can submit a verdict.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        if (state.phase === "awaiting_decomposition") return JSON.stringify({ ok: false, error: "Run is awaiting decomposition; call design_decompose." }, null, 2)
        assertPhase(state, ["designing"])
        if (state.paused) return JSON.stringify({ ok: false, error: "Run is paused; call design_resume first." }, null, 2)
        if (state.design_revision === "v0") return JSON.stringify({ ok: false, error: "No design revision yet; the Architect must produce v1 first." }, null, 2)
        beginRound(state)
        await saveState(ctx.directory, state)
        return JSON.stringify({ ok: true, round: state.round, status: summarize(state) }, null, 2)
      },
      { tool: "design_begin_round", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_RECORD_EVIDENCE = tool({
  description: "Record an evidence artifact (a command and its output, or a citation) so findings can cite it. Returns an evidence id (E-###). Findings with executable/model_checked class must cite a recorded executable/model_checked/authoritative artifact or they are downgraded.",
  args: {
    slug: z.string().optional(),
    class: z.enum(["executable", "authoritative", "model_checked", "structured_argument"]).describe("Evidence class."),
    output: z.string().optional().describe("The observed output, citation text, or the reasoning. For a dispatched agent's executable/model_checked evidence the plugin records the captured bash output instead."),
    command: z.string().optional().describe("The command run, for executable/model_checked evidence."),
    exit_code: z.number().int().optional(),
    artifact_ref: z.string().optional().describe("Artifact section this evidence bears on."),
  },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        if (TERMINAL.has(state.phase) || state.phase === "eliciting" || state.phase === "awaiting_confirmation") return JSON.stringify({ ok: false, error: "No round in progress." }, null, 2)
        let { output, command, exit_code } = args
        let captured = false
        if ((state.managed_sessions || []).includes(ctx.sessionID) && (args.class === "executable" || args.class === "model_checked")) {
          let runs = shellRuns.get(ctx.sessionID) || []
          if (state.dispatch?.child_session_id === ctx.sessionID) runs = runs.filter((r) => r.at >= Date.parse(state.dispatch.started_at))
          const want = args.command?.trim()
          const run = [...runs].reverse().find((r) => !want || r.command === want)
          if (!run) {
            const recent = runs.slice(-5).map((r) => `- ${r.command}`).join("\n")
            return JSON.stringify({ ok: false, error: `executable/model_checked evidence must come from a command run with the bash tool in this turn. Run it, then record it with the same command.${recent ? `\nCommands run this turn:\n${recent}` : ""}` }, null, 2)
          }
          command = run.command
          output = run.output
          exit_code = run.exit ?? undefined
          captured = true
        }
        if (!output?.trim()) return JSON.stringify({ ok: false, error: "output is required (nothing was captured for this evidence)." }, null, 2)
        const id = nextId(state, "E-", state.evidence)
        const rec = {
          id,
          class: args.class,
          command: command || null,
          exit_code: exit_code ?? null,
          captured,
          digest: digest(output),
          output_preview: String(output).slice(0, 2000),
          artifact_ref: args.artifact_ref || null,
          round: state.round,
          at: nowIso(),
        }
        state.evidence.push(rec)
        await writeJsonAtomic(path.join(designDir(ctx.directory, slug), ".crucible", "evidence", `${id}.json`), { ...rec, output })
        await saveState(ctx.directory, state)
        return JSON.stringify({ ok: true, id, captured, digest: rec.digest, status: summarize(state) }, null, 2)
      },
      { tool: "design_record_evidence", roles: ["architect", "falsifier"] },
    )
  },
})

const DESIGN_RECORD_DECISION = tool({
  description: "Architect/Referee: record a design decision in the decision ledger, amend one by id, or supersede a prior one (set supersedes to its id).",
  args: {
    slug: z.string().optional(),
    decision: z.string().describe("The decision."),
    rationale: z.string().optional(),
    alternatives: z.array(z.string()).optional(),
    id: z.string().optional().describe("Stable id (D-###); auto-assigned if omitted."),
    supersedes: z.string().optional().describe("Id of a decision this supersedes."),
  },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        if (TERMINAL.has(state.phase) || state.phase === "eliciting" || state.phase === "awaiting_confirmation") return JSON.stringify({ ok: false, error: "No active round to record a decision for." }, null, 2)
        const item: any = { decision: args.decision, rationale: args.rationale, alternatives: args.alternatives, id: args.id, supersedes: args.supersedes }
        upsertDecisions(state, [item])
        await notifyEscalations(ctx.directory, state)
        await saveState(ctx.directory, state)
        return JSON.stringify({ ok: true, id: item.id, escalation: state.escalation, status: summarize(state) }, null, 2)
      },
      { tool: "design_record_decision", roles: ["architect"] },
    )
  },
})

const DESIGN_SUBMIT_VERDICT = tool({
  description: "Falsifier: submit the round verdict as a JSON string. Stores the verdict and the coverage matrix.",
  args: { slug: z.string().optional(), verdict_json: z.string().describe("JSON verdict object as a string.") },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        // One verdict per round: a second submit (any phase) is the stored one.
        if (state.verdicts[state.round]) {
          return JSON.stringify({ ok: true, already: true, round: state.round, status: summarize(state) }, null, 2)
        }
        assertPhase(state, ["falsifying"])
        let verdict: any
        try {
          verdict = JSON.parse(args.verdict_json)
        } catch (e: any) {
          return JSON.stringify({ ok: false, error: `verdict_json is not valid JSON: ${e.message}` }, null, 2)
        }
        const problems = verdictProblems(state, verdict)
        if (problems.length) return JSON.stringify({ ok: false, error: problems[0], problems }, null, 2)
        for (const f of verdict.findings) f.id = String(f.id).trim()
        downgradeUnbackedEvidence(state, verdict)

        const round = state.round
        state.verdicts[round] = verdict
        await writeJsonAtomic(path.join(designDir(ctx.directory, slug), ".crucible", "verdicts", `round-${String(round).padStart(2, "0")}.json`), verdict)
        state.coverage.examined = recentlyExamined(state)
        refreshCoverage(state)
        // Classify now so status, gate, and parent blocks read the ladder's result.
        applyValidation(state, round, verdict, null)
        // The previous round's finding escalations are moot now.
        withdrawStaleEscalations(state)
        // Put the user's questions to them now, while the Architect works: rulings the Falsifier asked for and gate-worthy gaps.
        for (const f of state.open_findings) {
          if (f.round !== round || f.status === "rejected_noise") continue
          if (awaitsUser(f)) addEscalation(state, { requirement_id: f.id, kind: "finding", round, reason: `${f.severity} ${f.id}: ${adjudicationWhy(f)}` })
          else if (f.category === "requirement_gap" && GATE_SEVERITIES.has(f.severity)) {
            addEscalation(state, { requirement_id: f.id, kind: "finding", round, reason: `requirement_gap finding '${f.id}' needs user ratification` })
          }
        }
        await notifyEscalations(ctx.directory, state)
        state.phase = "responding"
        // A verification pass settles the pending acceptance without another Architect turn.
        if (state.verify) {
          state.phase = settleVerification(state)
          if (state.phase === "budget_stopped") state.stop_reason = "fix_not_verified"
        }
        // A clean verification of a decompose root's own design opens its decomposition hold.
        const ingested = state.phase === "awaiting_decomposition" && (await holdForDecomposition(ctx.directory, slug, state))
        await propagateBlocks(ctx.directory, state, false)
        await finalizeTerminal(ctx.directory, state)
        await saveState(ctx.directory, state)
        if (ingested) await pumpChildren(ctx.directory, slug)
        if (TERMINAL.has(state.phase)) await afterRunChange(ctx.directory, state)
        return JSON.stringify({ ok: true, round, findings: state.open_findings.length, coverage_gaps: state.coverage.gaps, status: summarize(state) }, null, 2)
      },
      { tool: "design_submit_verdict", roles: ["falsifier"] },
    )
  },
})

const DESIGN_RESPOND = tool({
  description: "Architect: submit dispositions for the current findings as a JSON string. On the initial call produces v1; after a verdict it produces the next revision and triggers validation. May include a decisions array.",
  args: { slug: z.string().optional(), response_json: z.string().describe("JSON response object as a string.") },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        if (state.phase === "designing" && state.design_revision !== "v0") {
          return JSON.stringify({ ok: false, error: "This run already has an initial design; begin a round and submit a verdict before responding." }, null, 2)
        }
        assertPhase(state, ["designing", "responding"])
        let response: any
        try {
          response = JSON.parse(args.response_json)
        } catch (e: any) {
          return JSON.stringify({ ok: false, error: `response_json is not valid JSON: ${e.message}` }, null, 2)
        }
        const wasResponding = state.phase === "responding"
        const problems = responseProblems(state, response, !wasResponding)
        if (problems.length) return JSON.stringify({ ok: false, error: problems[0], problems }, null, 2)
        if (Array.isArray(response.decisions)) upsertDecisions(state, response.decisions)

        const round = state.round
        const reviewedRevision = state.design_revision
        state.responses[wasResponding ? round : "initial"] = response
        state.design_revision = nextRevision(state.design_revision)

        state.spec_lines = await specSize(ctx.directory, slug)
        const specBudget = state.budgets.max_spec_lines
        if (specBudget && state.spec_lines > specBudget) {
          if (!state.spec_over_notified) {
            state.spec_over_notified = true
            addEscalation(state, { requirement_id: "spec-budget", kind: "guard", reason: `design is ${state.spec_lines} lines (budget ${specBudget}); simplify` })
          }
        } else if ((state.escalations || []).some((e: any) => e.requirement_id === "spec-budget")) {
          // Back within budget: withdraw the stale escalation and re-arm the alert.
          removeEscalation(state, "spec-budget")
          state.spec_over_notified = false
        }

        if (!wasResponding) {
          await notifyEscalations(ctx.directory, state)
          await saveState(ctx.directory, state)
          return JSON.stringify({ ok: true, phase: state.phase, revision: state.design_revision, status: summarize(state) }, null, 2)
        }

        await writeJsonAtomic(path.join(designDir(ctx.directory, slug), ".crucible", "responses", `round-${String(round).padStart(2, "0")}.json`), response)
        recordRound(state, response, reviewedRevision)
        // A decompose root holds once its own gate is clean; the Architect writes decomposition.json.
        let ingested = false
        if (state.decompose && (state.subsystems || []).length === 0) {
          const withinBudget = !state.budgets.max_spec_lines || (state.spec_lines || 0) <= state.budgets.max_spec_lines
          const gateClean = boardClean(state) && withinBudget
          if (gateClean && !isAcceptedTerminal(state.phase)) {
            // Subsystems are designed on top of this: fixes the Falsifier has not seen get one pass first.
            const fixes = unverifiedFixes(state).map((f: any) => f.id)
            if (fixes.length) state.verify = { target: "awaiting_decomposition", ids: fixes, round: state.round }
            else ingested = await holdForDecomposition(ctx.directory, slug, state)
          }
        }
        await notifyEscalations(ctx.directory, state)
        await toastProgress(ctx.directory, state)
        await finalizeTerminal(ctx.directory, state)
        // Subsystem blocks follow this round's validated findings; advance only after the root persists.
        const reopened = await propagateBlocks(ctx.directory, state, true)
        await saveState(ctx.directory, state)
        for (const s of reopened) await advance(ctx.directory, s)
        if (ingested) await pumpChildren(ctx.directory, slug)
        await afterRunChange(ctx.directory, state)
        const after = (await readState(ctx.directory, slug)) || state
        return JSON.stringify({ ok: true, phase: after.phase, revision: after.design_revision, history: after.history, status: summarize(after) }, null, 2)
      },
      { tool: "design_respond", roles: ["architect"] },
    )
  },
})

const DESIGN_DISPATCH = tool({
  description: "Referee-only: start/continue the automated loop by dispatching the next agent (architect or falsifier) in a child session.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        if (TERMINAL.has(state.phase)) return JSON.stringify({ ok: false, error: `Run is terminal: ${state.phase}.` }, null, 2)
        if (state.paused) return JSON.stringify({ ok: false, error: "Run is paused; call design_resume first." }, null, 2)
        if (state.phase === "eliciting" || state.phase === "awaiting_confirmation") return JSON.stringify({ ok: false, error: "Confirm the requirement ledger first." }, null, 2)
        if (state.dispatch) return JSON.stringify({ ok: true, already: true, dispatch: state.dispatch }, null, 2)
        await bindSession(ctx.directory, ctx.sessionID, slug)
        // The session driving the run now speaks for the user.
        if (!state.parent_slug && ctx.sessionID && state.session_id !== ctx.sessionID) {
          state.session_id = ctx.sessionID
          await saveState(ctx.directory, state)
        }
        await advance(ctx.directory, slug)
        const after = await readState(ctx.directory, slug)
        if (!after) return JSON.stringify({ ok: false, error: "Run state disappeared during dispatch." }, null, 2)
        return JSON.stringify({ ok: true, phase: after.phase, round: after.round, dispatch: after.dispatch ? { role: after.dispatch.role, child: after.dispatch.child_session_id } : null }, null, 2)
      },
      { tool: "design_dispatch", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_DECOMPOSE = tool({
  description: "Referee-only: ingest a decomposition manifest, validate it, and create the subsystem runs (decompose roots only).",
  args: {
    slug: z.string().optional(),
    decomposition_json: z.string().optional().describe("The decomposition manifest as JSON. Omit to ingest the run's decomposition.json (written by the Architect)."),
  },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        if (!state.decompose) return JSON.stringify({ ok: false, error: "Run is not a root; start it with design_start({decompose:true})." }, null, 2)
        if (TERMINAL.has(state.phase)) return JSON.stringify({ ok: false, error: `Run is terminal (${state.phase}); decomposition is closed.` }, null, 2)
        const existing = (state.subsystems || []).length > 0
        if (!existing && state.phase !== "awaiting_decomposition") {
          return JSON.stringify({ ok: false, error: "design_decompose requires the decomposition hold (awaiting_decomposition)." }, null, 2)
        }
        let manifest: any
        if (args.decomposition_json) {
          try {
            manifest = JSON.parse(args.decomposition_json)
          } catch (e: any) {
            return JSON.stringify({ ok: false, error: `decomposition_json is not valid JSON: ${e.message}` }, null, 2)
          }
        } else {
          manifest = await readDecompositionManifest(ctx.directory, slug)
          if (!manifest) return JSON.stringify({ ok: false, error: `No decomposition_json given and no ${relDesignDir(ctx.directory, slug)}/decomposition.json found.` }, null, 2)
        }
        const { problems } = validateDecomposition(state, slug, manifest)
        if (problems.length) return JSON.stringify({ ok: false, problems }, null, 2)
        const subs = await ingestDecomposition(ctx.directory, slug, state, manifest, existing)
        await pumpChildren(ctx.directory, slug)
        const after = await readState(ctx.directory, slug)
        return JSON.stringify(
          { ok: true, subsystems: subs.map((s: any) => s.slug), traceability_gaps: after ? traceabilityGaps(after) : [], status: after ? summarize(after) : summarize(state) },
          null,
          2,
        )
      },
      { tool: "design_decompose", roles: REFEREE_ONLY },
    )
  },
})

// Lookup scope: the named run's effort plus this session's; an unbound session sees the worktree.
async function lookupSlugs(dir: string, sessionID: string | undefined, explicit?: string) {
  const out = new Set<string>(await sessionEffortSlugs(dir, sessionID))
  if (explicit) for (const s of await effortSlugs(dir, normalizeSlug(explicit))) out.add(s)
  if (out.size === 0) for (const s of await worktreeSlugs(dir)) out.add(s)
  return out
}

const DESIGN_ESCALATIONS = tool({
  description: "List pending escalations across this session's runs (root and subsystems), with the related finding, so the user can ratify them.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    const items: any[] = []
    for (const slug of await lookupSlugs(ctx.directory, ctx.sessionID, args.slug)) {
      const st = await readState(ctx.directory, slug)
      if (!st) continue
      // Every pending escalation, not just the primary mirror.
      for (const e of pendingEscalations(st)) {
        const findingLinked = isFindingEscalation(e)
        const f = findingLinked ? (st.open_findings || []).find((x: any) => x.id === e.requirement_id) : null
        items.push({
          slug,
          phase: st.phase,
          paused: st.paused === true,
          kind: findingLinked ? "finding" : "notice",
          escalation: e,
          finding: f ? { id: f.id, severity: f.severity, category: f.category, status: f.status, contested: f.contested === true, architect: f.disposition || null, claim: f.claim } : null,
          // The escalation references a finding id that no longer exists; clearing it is enough.
          stale: findingLinked && !f,
        })
      }
    }
    return JSON.stringify(
      {
        ok: true,
        count: items.length,
        escalations: items,
        hint: "Decide a finding with design_decide { finding_id, decision: resolved|accepted_risk|reopen }; acknowledge a notice with decision accepted_risk.",
      },
      null,
      2,
    )
  },
})

const DESIGN_DECIDE = tool({
  description: "Referee/user: adjudicate a finding (resolve, accept the risk, or reopen it), or acknowledge a non-finding notice. Finds the item across this session's runs.",
  args: { slug: z.string().optional(), finding_id: z.string().describe("Finding (or escalation) id to adjudicate."), decision: z.enum(["resolved", "accepted_risk", "reopen"]), rationale: z.string().optional() },
  async execute(args, ctx) {
    await assertCaller(ctx.directory, ctx.sessionID, "design_decide", REFEREE_ONLY)
    // Locate the run holding the finding: escalation match, then open finding, then explicit slug.
    const explicit = new Set<string>()
    if (args.slug) explicit.add(normalizeSlug(args.slug))
    const candidates = new Set<string>([...explicit, ...(await lookupSlugs(ctx.directory, ctx.sessionID, args.slug))])
    const scored: Array<{ slug: string; score: number; open: boolean }> = []
    for (const slug of candidates) {
      const st = await readState(ctx.directory, slug)
      if (!st) continue
      const f = (st.open_findings || []).find((x: any) => x.id === args.finding_id)
      if (!f) continue
      const open = !["resolved", "accepted_risk"].includes(f.status)
      const escalated = pendingEscalations(st).some((e: any) => e.requirement_id === args.finding_id)
      const score = (escalated ? 4 : 0) + (open ? 2 : 0) + (explicit.has(slug) ? 1 : 0)
      scored.push({ slug, score, open })
    }
    scored.sort((a, b) => b.score - a.score)
    if (scored.length === 0) {
      // No finding by that id: it may be a non-finding notice or a stale escalation to clear.
      for (const slug of candidates) {
        const st = await readState(ctx.directory, slug)
        if (!st) continue
        const e = pendingEscalations(st).find((x: any) => x.requirement_id === args.finding_id)
        if (!e) continue
        return lockedState(ctx.directory, slug, ctx.sessionID, async (_s, state) => {
          let result: any
          if (isFindingEscalation(e)) {
            removeEscalation(state, args.finding_id)
            result = { ok: true, slug, cleared: true, reason: `finding '${args.finding_id}' is no longer present; stale escalation cleared` }
          } else {
            acknowledgeEscalation(state, args.finding_id)
            result = {
              ok: true,
              slug,
              acknowledged: true,
              reason: `'${args.finding_id}' acknowledged; it will not be raised again unless its situation changes. The underlying gate still applies.`,
            }
          }
          if (TERMINAL.has(state.phase)) await writeOpenIssues(ctx.directory, state)
          await saveState(ctx.directory, state)
          return JSON.stringify(result, null, 2)
        })
      }
      return JSON.stringify({ ok: false, error: `Finding '${args.finding_id}' is not open in any run for this session.` }, null, 2)
    }
    const top = scored[0]
    if (scored[1] && scored[1].score === top.score && scored[1].open && top.open && scored[1].slug !== top.slug) {
      return JSON.stringify({ ok: false, error: `Finding '${args.finding_id}' is open in both ${top.slug} and ${scored[1].slug}; pass an explicit slug to choose.` }, null, 2)
    }
    const target = top.slug
    return lockedState(ctx.directory, target, ctx.sessionID, async (slug, state) => {
      const finding = state.open_findings.find((f: any) => f.id === args.finding_id)
      if (!finding) return JSON.stringify({ ok: false, error: `Unknown finding '${args.finding_id}'.` }, null, 2)
      state.adjudications = state.adjudications || {}
      const round = finding.round ?? state.round
      if (args.decision === "reopen") {
        // Reopen: a finding waiting on the user now stands (and stays so for the Architect); others re-run the ladder.
        const { status, ratified } = reopenStatus(state, finding)
        if (ratified) state.adjudications[args.finding_id] = { decision: "binding", round }
        else delete state.adjudications[args.finding_id]
        finding.status = status
        finding.contested = false
        finding.decided_by = null
      } else {
        finding.status = args.decision
        finding.contested = false
        finding.decided_by = "user"
        // Persist so a later Architect response cannot undo it.
        state.adjudications[args.finding_id] = { decision: args.decision, round }
      }
      finding.decision_rationale = args.rationale || ""
      // Adjudicating a finding withdraws an escalation that pointed at it.
      removeEscalation(state, args.finding_id)
      // A root's subsystem blocks follow the adjudicated status.
      const reopened = await propagateBlocks(ctx.directory, state, true)
      // The ruling may be all the last scored round was waiting for.
      const changed = rescore(state)
      if (changed && TERMINAL.has(state.phase)) await finalizeTerminal(ctx.directory, state)
      else if (TERMINAL.has(state.phase)) await writeOpenIssues(ctx.directory, state)
      await saveState(ctx.directory, state)
      for (const s of reopened) await advance(ctx.directory, s)
      if (changed) await afterRunChange(ctx.directory, state)
      // A run that now awaits a verification pass (or its Architect) is driven on.
      if ((state.phase === "responding" || (changed && state.verify)) && !state.dispatch) await advance(ctx.directory, slug)
      return JSON.stringify({ ok: true, slug, finding, status: summarize(state) }, null, 2)
    })
  },
})

const DESIGN_PROTOCOL = tool({
  description: "Return the Crucible protocol: roles, phases, tool list, schemas, validation ladder, and rules. Agents call this on their first dispatch.",
  args: {},
  async execute() {
    return PROTOCOL
  },
})

const DESIGN_STATUS = tool({
  description: "Show the Crucible run status, including decomposition and traceability for roots.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    const { slug } = await requireState(ctx.directory, args.slug, ctx.sessionID)
    const state = (await refreshDecomposition(ctx.directory, slug)) || (await readState(ctx.directory, slug))
    return JSON.stringify(
      {
        ...summarize(state),
        design_dir: relDesignDir(ctx.directory, slug),
        parent_slug: state.parent_slug || null,
        domains: state.domains || [],
        subsystems: (state.subsystems || []).map((s: any) => s.slug || s.name),
        waiting_on: state.waiting_on || [],
        children: state.children || [],
        config: configOf(state),
        traceability_gaps: traceabilityGaps(state),
        traceability_blocked: state.traceability_blocked === true,
        interfaces: state.interfaces || [],
        interface_gaps: interfaceGaps(state),
        interface_blocked: state.interface_blocked === true,
        acceptance_blocked_by_parent: state.acceptance_blocked_by_parent || null,
        parent_block_findings: state.parent_block_findings || [],
      },
      null,
      2,
    )
  },
})

const DESIGN_LIST = tool({
  description: "List Crucible runs in this worktree, optionally a root's subtree, with phase/round/terminal and scale fields.",
  args: { root: z.string().optional().describe("Return only this root and its children.") },
  async execute(args, ctx) {
    const bound = new Set((await boundRunsIn(ctx.directory, ctx.sessionID)).map((r: any) => r.slug))
    const current = await resolveSlug(ctx.directory, undefined, ctx.sessionID)
    const all: any[] = []
    for (const slug of await worktreeSlugs(ctx.directory)) {
      const st = await readState(ctx.directory, slug)
      if (!st) continue
      all.push({
        slug,
        system: st.system,
        phase: st.phase,
        round: st.round,
        revision: st.design_revision,
        paused: st.paused === true,
        parent_slug: st.parent_slug || null,
        domains: st.domains || [],
        waiting_on: st.waiting_on || [],
        escalation: st.escalation ? { requirement_id: st.escalation.requirement_id, reason: st.escalation.reason, status: st.escalation.status } : null,
        terminal: TERMINAL.has(st.phase),
        bound_to_session: bound.has(slug),
        current: slug === current,
        updated_at: st.updated_at,
      })
    }
    let runs = all
    if (args.root) {
      const root = normalizeSlug(args.root)
      runs = all.filter((r) => r.slug === root || r.parent_slug === root)
    }
    runs.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    return JSON.stringify({ ok: true, current, runs }, null, 2)
  },
})

async function rootLooseEnds(dir: string, root: any) {
  const kids = await Promise.all(root.subsystems.map((s: any) => readState(dir, childSlug(root, s)).catch(() => null)))
  return kids.filter(Boolean).flatMap((c: any) => looseEnds(c))
}

const DESIGN_GET_CONTEXT = tool({
  description: "Return the hand-off payload for an agent role (architect|falsifier).",
  args: { slug: z.string().optional(), role: z.enum(["architect", "falsifier"]).optional() },
  async execute(args, ctx) {
    const { slug, state } = await requireState(ctx.directory, args.slug, ctx.sessionID)
    // Bind the role to the calling session so a role cannot request the other's hand-off.
    let role: "architect" | "falsifier" = args.role || "architect"
    if (state.sessions?.architect === ctx.sessionID) role = "architect"
    else if (state.sessions?.falsifier === ctx.sessionID) role = "falsifier"
    const loose = state.decompose && !state.parent_slug && state.subsystems.length ? await rootLooseEnds(ctx.directory, state) : undefined
    return JSON.stringify(handoff(state, role, { designDir: relDesignDir(ctx.directory, slug), shellPolicy: effectiveShellPolicy(state), looseEnds: loose, scratchDir: runScratch(slug) }), null, 2)
  },
})

const DESIGN_PAUSE = tool({
  description: "Pause the run (user interrupt).",
  args: { slug: z.string().optional(), reason: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        if (TERMINAL.has(state.phase)) return JSON.stringify({ ok: true, already: true, status: summarize(state) }, null, 2)
        state.paused = true
        state.paused_reason = args.reason || "user_pause"
        // Abort the in-flight turn BEFORE clearing dispatch (abortSessions reads it).
        await abortSessions(ctx.directory, state, true)
        state.dispatch = null
        // Pausing a root pauses the whole effort: stop and flag its subsystems too.
        if (state.decompose && !state.parent_slug) {
          for (const sub of state.subsystems || []) {
            const child = await readState(ctx.directory, childSlug(state, sub))
            if (!child || TERMINAL.has(child.phase)) continue
            child.paused = true
            child.paused_reason = "parent_pause"
            await abortSessions(ctx.directory, child, true)
            child.dispatch = null
            await saveState(ctx.directory, child)
          }
        }
        await saveState(ctx.directory, state)
        return JSON.stringify({ ok: true, status: summarize(state) }, null, 2)
      },
      { tool: "design_pause", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_RESUME = tool({
  description: "Resume a paused run, or reopen a terminal one.",
  args: { slug: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (slug, state) => {
        const wasPaused = state.paused === true
        const wasTerminal = TERMINAL.has(state.phase)
        if (!wasPaused && !wasTerminal) return JSON.stringify({ ok: false, error: "Run is not paused or terminal." }, null, 2)
        state.paused = false
        state.paused_reason = null
        if (wasTerminal) {
          // Reopen any terminal run with fresh progress counters.
          state.phase = state.stopped_from || "designing"
          state.stopped_from = null
          state.stop_reason = null
          resetProgressCounters(state)
        }
        if (!state.parent_slug && ctx.sessionID) state.session_id = ctx.sessionID
        await saveState(ctx.directory, state)
        await bindSession(ctx.directory, ctx.sessionID, slug)
        // Resuming a root resumes its subsystems and re-pumps the ready ones.
        if (state.decompose && !state.parent_slug) {
          for (const sub of state.subsystems || []) {
            const child = await readState(ctx.directory, childSlug(state, sub))
            if (!child) continue
            let changed = false
            if (child.paused) {
              child.paused = false
              child.paused_reason = null
              changed = true
            }
            // Reopen an unaccepted subsystem so a blocked effort can progress.
            if (TERMINAL.has(child.phase) && !isAcceptedTerminal(child.phase)) {
              child.phase = child.stopped_from || "designing"
              child.stopped_from = null
              child.dispatch = null
              child.stop_reason = null
              resetProgressCounters(child)
              changed = true
            }
            if (changed) await saveState(ctx.directory, child)
          }
          await pumpChildren(ctx.directory, slug)
          const fresh = await readState(ctx.directory, slug)
          if (fresh && !fresh.dispatch && !TERMINAL.has(fresh.phase) && fresh.phase !== "awaiting_decomposition") await advance(ctx.directory, slug)
        } else if (!state.dispatch && !TERMINAL.has(state.phase)) {
          await advance(ctx.directory, slug)
        }
        // A reopened subsystem is waited on by its root again.
        await afterRunChange(ctx.directory, state)
        const fresh = await readState(ctx.directory, slug)
        return JSON.stringify({ ok: true, status: summarize(fresh || state) }, null, 2)
      },
      { tool: "design_resume", roles: REFEREE_ONLY },
    )
  },
})

const DESIGN_STOP = tool({
  description: "Stop the run permanently (resume can reopen it). On a root, stops its subsystems too.",
  args: { slug: z.string().optional(), reason: z.string().optional() },
  async execute(args, ctx) {
    return lockedState(
      ctx.directory,
      args.slug,
      ctx.sessionID,
      async (_slug, state) => {
        // An already-terminal run keeps its outcome; its subsystems are still stopped.
        const already = TERMINAL.has(state.phase)
        await abortSessions(ctx.directory, state)
        if (!already) {
          state.stopped_from = state.phase
          state.phase = "stopped"
          state.stop_reason = args.reason || "user_stop"
        }
        state.dispatch = null
        state.paused = false
        // Persist the terminal root before stopping subsystems.
        await saveState(ctx.directory, state)
        // Stopping a root marks non-terminal subsystems stopped so recovery never revives them.
        if (state.decompose && !state.parent_slug) {
          for (const sub of state.subsystems || []) {
            const child = await readState(ctx.directory, childSlug(state, sub))
            if (!child || TERMINAL.has(child.phase)) continue
            child.stopped_from = child.phase
            child.phase = "stopped"
            child.stop_reason = "parent_stopped"
            child.dispatch = null
            child.paused = false
            await finalizeTerminal(ctx.directory, child)
            await saveState(ctx.directory, child)
          }
          state.children = await buildChildren(ctx.directory, state)
          state.waiting_on = waitingOn(state)
        }
        if (!already) await finalizeTerminal(ctx.directory, state)
        await saveState(ctx.directory, state)
        // A stopped subsystem fails its root's gate.
        if (!already) await afterRunChange(ctx.directory, state)
        return JSON.stringify({ ok: true, ...(already ? { already: true } : {}), status: summarize(state) }, null, 2)
      },
      { tool: "design_stop", roles: REFEREE_ONLY },
    )
  },
})

// --- injected agents and command -------------------------------------------

const ARCHITECT_PROMPT = `You are the Crucible Architect (generator) in an adversarial design loop.
A dispatch message gives you a run slug, round, and working directory (the run's design directory). Before acting, call design_protocol (no arguments) to load the protocol.
Then call design_get_context with { slug, role: "architect" } to get the requirements, decisions, evidence, and open findings.
Record each meaningful design choice with design_record_decision (decision, rationale, alternatives); to reverse a prior decision, call it with supersedes set to that decision's id. You may also include a decisions array in your response.
If the run has no design revision yet (round 0, no open findings), create the design artifacts in the working directory (at least 03-architecture.md, 04-decisions.md, 05-risks.md, 06-operability.md), trace every requirement id, and call design_respond with response_json {"round":0,"design_revision":"v1","responses":[]}.
Otherwise, for each open finding choose fix | rebut | accept_risk | simplify | wont_fix, revise the artifacts on disk, and call design_respond with response_json {"round":<round>,"design_revision":"v<next>","responses":[{"finding_id","disposition","rationale","artifact_change"}]}. On a decompose root, a finding with subsystem_ref can only be fixed inside that subsystem: describe the needed change; the plugin reopens the subsystem with it. Answer the open findings in the hand-off by their exact ids (these may include findings held from earlier rounds). Try to refute a finding before accepting it; for a rebut, supply refutation_evidence {class, verification:"verified", detail} and, when the claim is checkable, record the check first with design_record_evidence (run the command with bash this turn, then record it with the same command) and cite its id as refutation_evidence.artifact_id (required for executable/model_checked). A rebut without verified strong evidence does not close a gating finding: it keeps gating and goes to the user for adjudication. Any server or background process you start for evidence (e.g. a database under the run's scratch directory, $CRUCIBLE_SCRATCH) must be stopped before you end your turn (the plugin also kills leftovers at the end of your turn). Containers started with docker or podman run are removed then too; prefer --rm. Use only read-only git (status, log, diff, show); never commit, stage, switch branches or stash, because the user owns the repository.
Minimalism: prefer the smallest change that resolves a finding; reuse existing code and prior decisions; do not add a mechanism, option, or document section that no requirement demands. If a finding asks for disproportionate complexity, use disposition "simplify" (remove or reduce) or "wont_fix" (a justified deliberate non-fix) instead of adding machinery. Each round, also look for something to remove or simplify. Keep the design within the spec-size budget shown in the dispatch/handoff.
If this run is a decompose root and your own design has no gating finding, full coverage, and is within the spec-size budget, ALSO write decomposition.json in the working directory so the run can split automatically: {"version":1,"system_slug":"<slug>","max_parallel":<int>,"subsystems":[{"name","namespace":"UPPERTOKEN","title","required":true,"depends_on":[],"domains":[],"requirements":[{"id":"<NS>-R-001","text","priority","acceptance","system_reqs":["R-00x"]}],"provides":[],"requires":[]}],"interfaces":[{"from","to","contract","system_reqs":[]}],"traceability":[{"system_req":"R-00x","subsystems":[],"subsystem_reqs":[]}]}. Rules: subsystem names must stay distinct once lowercased/slugified and namespaces must be unique; requirement ids are namespaced (<NS>-R-###) and unique; system_reqs cite only must/should system requirements; every system must/should requirement appears in traceability with subsystem_reqs naming real subsystem requirement ids; every "requires" contract is "provides"d by a sibling AND declared by an interfaces entry {"from": provider, "to": consumer, "contract": the same string}, and each interface's contract must appear in its from.provides and to.requires. The plugin ingests it automatically (or asks the user first, per the run's decomposition setting).
Do not write state or verdict/response JSON files yourself; write files only in the working directory (scratch files in the run's scratch directory, $CRUCIBLE_SCRATCH), and do not edit 00-brief.md, 01-requirements.md (plugin-owned) or 07-review-log.md (the Falsifier's); the design_* tools persist everything. Call the required tool before ending your turn.`

const FALSIFIER_PROMPT = `You are the Crucible Falsifier (discriminator) in an adversarial design loop.
A dispatch message gives you a run slug, round, and working directory (the run's design directory). Before acting, call design_protocol (no arguments) to load the protocol.
Then call design_get_context with { slug, role: "falsifier" }.
Adversarially search for reasons the design fails: requirement gaps, contradictions, ambiguity, and concrete failure scenarios. Use the shell to ground claims when possible.
For every executable or model_checked claim, first run the command with the bash tool this turn, then call design_record_evidence (class, same command; the plugin captures the real output and exit code) and put the returned id in the finding's evidence.artifact_id. Findings without a recorded executable/model_checked/authoritative artifact are downgraded and will not gate convergence. Any server or background process you start for evidence (e.g. a database under the run's scratch directory, $CRUCIBLE_SCRATCH) must be stopped before you end your turn (the plugin also kills leftovers at the end of your turn). Containers started with docker or podman run are removed then too; prefer --rm. Use only read-only git (status, log, diff, show); never commit, stage, switch branches or stash, because the user owns the repository.
Every finding needs a unique id (number new findings from next_finding_id in the hand-off; an old id re-raises that finding, and a resolved one needs evidence recorded this round), a severity (blocker | major | minor), a category, a concrete counterexample, a requirement/constraint citation (requirement_ids or constraint_ref), an artifact_ref, and evidence {class, verification}. verification is one of hypothesis | supported | verified | disputed; use verified only when you have a recorded artifact or authoritative citation. action is "open" (default) or "needs_adjudication". Use needs_adjudication to put a question only the user can settle (e.g. a contradiction between requirements): the user is asked at once, and the Architect cannot close it alone. Do not inflate severity. When a gap must be fixed inside a subsystem, set subsystem_ref on the finding.
Findings must be worth their cost: weigh severity and real risk against the complexity a fix would require, and do not demand disproportionate mechanism. Prioritize requirement gaps and concrete failure/risk over meta or internal-consistency nits, and cap those. It is valid to record a reservation as a minor finding rather than demand a change. If the design is over its spec-size budget, prioritize changes that remove or simplify.
Never edit the design artifacts or other project files. Write only 07-review-log.md in the working directory (append a short summary and the findings), plus scratch files in the run's scratch directory ($CRUCIBLE_SCRATCH).
Then call design_submit_verdict with verdict_json = the full verdict object (round, design_revision, verdict, summary, findings[], coverage{dimensions,examined (what you examined this round),gaps}, no_new_falsifiable_claim). If it reports problems, fix them and submit again. Call the tool before ending your turn; the tool persists state.`

const REFEREE_PROMPT = `You are the Crucible Referee. You run the adversarial design loop; you never design and never attack.
Call design_protocol first to load the protocol.
Elicit narrowly: capture the must-have requirements first and keep the brief minimal; add should/could requirements only if the user asks for them. A smaller, well-scoped design converges better than a broad one.
The brief, the requirements, and the settings are all PER RUN. When the user wants a system designed:
0. DRAFT THE BRIEF YOURSELF. Most users give a vague prompt; you have the conversation context. Compose a coherent brief: problem, goals, non-goals, stakeholders, and an explicit scope boundary (what is in and out for this run). If the user has no system in mind, propose 2-3 candidate systems first. Show the draft with the question tool (Approve / Edit / Regenerate) and incorporate edits; put the full drafted brief and requirement seed inside the question text itself, since the user may only see the question dialog.
1. Draft a MUST-ONLY requirement seed (5-8 items, each with acceptance criteria) from the brief. Show it with the brief.
2. Configure the run with the \`question\` tool (do not silently assume settings). Ask, as one form: effort preset (fast/standard/deep/exhaustive); decomposition (should the run be a root that splits into subsystem runs? yes/no — and if yes, whether to auto-ingest the Architect's split or confirm it with you); strictness (balanced/strict); models for the Architect and Falsifier (inherit, or provider/model — omit the argument or pass "inherit" to keep the default; recommend different models, ideally from different providers, since the Falsifier is strongest when it does not share the Architect's blind spots); shell policy (guarded/ask/allow; guarded runs without prompts and is not a sandbox, so suggest the user commit before the run starts); and, only if the user wants custom budgets, the round limit and spec-line limit. Show the resolved configuration and confirm.
3. Call design_start with the system name, the approved brief, the requirements seed, and the chosen settings (preset, decompose, decomposition, domains, max_parallel, max_rounds, max_spec_lines, k, m, majors_threshold, architect_model, falsifier_model, shell_policy, strict).
4. Refine requirements with the user if needed (the seed may already cover the musts); present the ledger and ask the user to confirm or amend, then end your turn.
5. After confirmation, call design_confirm_requirements, then design_dispatch to run the loop (architect and falsifier in child sessions).
5b. When a decompose root is in awaiting_decomposition and the plugin tells you the decomposition is ready (the Architect has written decomposition.json in the run's design directory), read it and the design, present the proposed decomposition to the user with the question tool (Approve / Edit / Cancel), and on approval call design_decompose with only the slug (it ingests the file). If the file is missing or invalid (design_status shows the problems), draft or fix the manifest from the design, write it there, then present and ingest it. With decomposition_mode 'auto' it is ingested without asking. The subsystem runs then start automatically (up to max_parallel); report again when the root has run its integration round.
6. Use design_status to report; pause/resume/stop on request; design_config to view or adjust a non-terminal run's settings; design_escalations to list what needs the user's ratification (root and subsystems) and design_decide to adjudicate a finding (it finds the finding across the effort).
6b. Whenever the plugin tells you a run needs the user (a pending escalation) or that a decomposition is ready for approval, you MUST call the \`question\` tool with the choices given — never only describe them in text. For a finding escalation, offer "Ratify as resolved" / "Accept the risk" / "Reopen" / "Leave for now" per item and call design_decide for the chosen action; for a notice (spec budget, traceability, interface, decision churn, subsystem rejection), offer "Acknowledge" / "Leave for now" and acknowledge with design_decide decision "accepted_risk". After deciding a finding whose ruling changes a requirement's meaning, call design_amend_requirement with the new text and the ruling as reason. Do not revise the design yourself.
7. At a terminal phase, summarize: convergence status, design directory, decisions, coverage, accepted and residual risks (see 08-open-issues.md).
Keep reports compact (tables), and never impersonate the architect or falsifier.`

const COMMAND_TEMPLATE = `Crucible. Arguments:

$ARGUMENTS

Call design_protocol first (it returns the protocol). Then, based on the first word of the arguments:
- "list": call design_list and show the runs (mark the current one for this session).
- "status": call design_status for the current run (pass a slug if one is given) and report it compactly.
- "pause": call design_pause for the current run, then confirm.
- "resume": call design_resume for the current run (this also reopens a stopped or otherwise terminal run), then report the phase.
- "stop": call design_stop for the current run, then report residual risks from 08-open-issues.md.
- "escalations": call design_escalations, then present EVERYTHING that needs my ratification with the question tool — one question per item; for a finding, options "Ratify as resolved" / "Accept the risk" / "Reopen" / "Leave for now"; for a notice, "Acknowledge" / "Leave for now" — and call design_decide for each choice. Do not only print the list.
- "decide <finding-id> resolved|accepted_risk|reopen": call design_decide (it locates the finding across this session's runs, including subsystems).
- "config": call design_config for the current run and show its settings.
- "configure": re-ask the run settings with the question tool, then call design_config with the chosen values for the current (non-terminal) run.
- "decompose": for the current root in awaiting_decomposition, read the Architect's decomposition.json in the run's design directory (if missing or invalid, draft or fix it from the design and write it), present it to me with the question tool (Approve / Edit / Cancel), then on approval call design_decompose with only the slug.
- otherwise (empty or a system brief): bootstrap a NEW run as the Referee, per run. FIRST draft a coherent brief yourself from this conversation (problem, goals, non-goals, stakeholders, scope boundary) plus a must-only requirement seed, and show it with the question tool for approval/edit. If I gave no system, propose 2-3 candidate systems. THEN ask the run settings with the question tool (effort preset, decomposition, strictness, models, shell policy; custom round/spec limits if requested), show the resolved configuration and confirm, then call design_start with the brief, requirements seed, and settings; present the ledger and ask me to confirm before dispatching the loop.`

// The bus-event work a Crucible run reacts to, as a deferred job (or null).
function eventJob(dir: string, event: any): (() => Promise<void>) | null {
  const sid = eventSessionID(event)
  const statusType = event?.properties?.status?.type
  if (event?.type === "session.deleted") {
    const id = event?.properties?.info?.id
    return id ? () => onSessionDeleted(dir, id) : null
  }
  if (!sid) return null
  if (event.type === "session.status" && statusType === "busy") return () => onBusy(dir, sid)
  if (event.type === "session.idle" || (event.type === "session.status" && statusType === "idle")) return () => onIdle(dir, sid)
  if (event.type === "session.error") return () => onSessionError(dir, sid, event?.properties?.error)
  return null
}

export const server = async (input: any, options?: any) => {
  CLIENT = input?.client
  OPTIONS = options || {}
  SERVER_URL = input?.serverUrl ? new URL(String(input.serverUrl)) : null
  // This instance's worktree, used by hooks (one process may host several instances).
  const directory = path.resolve(input?.directory || process.cwd())
  let disposed = false
  // Child shell defaults: no interactive prompts, destructive commands blocked.
  const bashPerm = OPTIONS.shellPolicy === "ask" ? "ask" : "allow"

  return {
    async config(cfg: any) {
      injectAgent(cfg, "architect", {
        description: "Crucible Architect: generates and revises the system design and its documentation.",
        mode: "subagent",
        model: OPTIONS.architectModel,
        temperature: 0.4,
        permission: { edit: "allow", bash: bashPerm },
        prompt: ARCHITECT_PROMPT,
      })
      injectAgent(cfg, "falsifier", {
        description: "Crucible Falsifier: adversarially attacks a design and reports evidence-backed findings.",
        mode: "subagent",
        model: OPTIONS.falsifierModel,
        temperature: 0.2,
        permission: { edit: "allow", bash: bashPerm },
        prompt: FALSIFIER_PROMPT,
      })
      // The Referee runs under the built-in build agent so it has the question tool.
      cfg.command = cfg.command || {}
      cfg.command.crucible = {
        description: "Start a Crucible adversarial design run for a system.",
        agent: "build",
        template: `${REFEREE_PROMPT}\n\n${COMMAND_TEMPLATE}`,
      }
      // Recover stale runs only after the agents/command are injected.
      if (!recoveredDirs.has(directory)) {
        recoveredDirs.add(directory)
        setTimeout(() => {
          if (!disposed) void recoverRuns(directory).catch(() => {})
        }, 2000)
      }
    },

    tool: {
      design_start: DESIGN_START,
      design_config: DESIGN_CONFIG,
      design_add_requirement: DESIGN_ADD_REQUIREMENT,
      design_amend_requirement: DESIGN_AMEND_REQUIREMENT,
      design_confirm_requirements: DESIGN_CONFIRM_REQUIREMENTS,
      design_begin_round: DESIGN_BEGIN_ROUND,
      design_record_evidence: DESIGN_RECORD_EVIDENCE,
      design_record_decision: DESIGN_RECORD_DECISION,
      design_submit_verdict: DESIGN_SUBMIT_VERDICT,
      design_respond: DESIGN_RESPOND,
      design_dispatch: DESIGN_DISPATCH,
      design_decompose: DESIGN_DECOMPOSE,
      design_decide: DESIGN_DECIDE,
      design_escalations: DESIGN_ESCALATIONS,
      design_status: DESIGN_STATUS,
      design_list: DESIGN_LIST,
      design_get_context: DESIGN_GET_CONTEXT,
      design_protocol: DESIGN_PROTOCOL,
      design_pause: DESIGN_PAUSE,
      design_resume: DESIGN_RESUME,
      design_stop: DESIGN_STOP,
    },

    async event({ event }: any) {
      try {
        const sid = eventSessionID(event)
        // Real work from a dispatched child resets its inactivity window.
        if (sid && WATCHDOG_ACTIVITY_EVENTS.has(event.type)) touchWatchdog(sid)
        if (sid && event.type === "message.part.updated") noteTool(sid, event.properties?.part)
        if (event.type === "permission.asked") enqueueEvent(() => onPermissionAsked(directory, event.properties))
        if (sid && event.type === "permission.replied") {
          const w = watchdogs.get(sid)
          if (w) w.waiting = false
        }
        if (sid && event.type === "session.compacted") lastCompacted.set(sid, Date.now())
        const job = eventJob(directory, event)
        if (!job) return
        // Handle events off the bus in arrival order to avoid deadlock.
        enqueueEvent(job)
      } catch {
        // never let an event handler reject into the bus
      }
    },

    // Mark every process a dispatched agent starts so killMarked can reap it (daemons escape process groups).
    async "shell.env"(input: any, output: any) {
      try {
        const caller = input?.sessionID ? await callerRun(directory, input.sessionID) : null
        if (!caller) return
        output.env.CRUCIBLE_SESSION = input.sessionID
        output.env.CRUCIBLE_WORKTREE = directory
        output.env.CRUCIBLE_SCRATCH = runScratch(caller.slug)
      } catch {
      }
    },

    async "tool.execute.after"(input: any, output: any) {
      try {
        if (String(input?.tool).toLowerCase() !== "bash" || !(await callerRun(directory, input.sessionID))) return
        const runs = shellRuns.get(input.sessionID) || []
        runs.push({ command: String(input.args?.command ?? "").trim(), output: String(output?.output ?? ""), exit: typeof output?.metadata?.exit === "number" ? output.metadata.exit : null, at: Date.now() })
        shellRuns.set(input.sessionID, runs.slice(-20))
      } catch {
        // never throw from a hook
      }
    },

    async "tool.execute.before"(input: any, output: any) {
      try {
        const sid = input?.sessionID
        if (!sid) return
        const toolName = String(input?.tool || "").toLowerCase()
        const shell = toolName === "bash"
        const files = shell ? [] : writtenPaths(toolName, output?.args)
        if (!shell && files.length === 0) return
        // Only plugin-dispatched sessions are guarded.
        const caller = await callerRun(directory, sid)
        if (!caller) return
        if (shell) {
          // Label containers so cleanup can find them (the daemon, not the shell, starts them).
          const c = output?.args?.command
          if (typeof c === "string") {
            const labels = `--label crucible.session=${sid} --label crucible.worktree='${directory.replace(/'/g, `'\\''`)}'`
            output.args.command = c.replace(/\b((?:docker|podman)(?:\s+container)?\s+run)\b/g, `$1 ${labels.replace(/\$/g, "$$$$")}`)
          }
          if (effectiveShellPolicy(caller.state) === "allow") return // per-run: guard disabled
          const cmd = String(output?.args?.command ?? output?.args?.cmd ?? "")
          if (isDestructive(cmd)) throw new Error("Crucible guard: destructive or repository-changing command blocked (read-only git such as status, log, diff and show is allowed).")
          return
        }
        for (const file of files) {
          const problem = fileGuard(directory, caller, file)
          if (problem) throw new Error(`Crucible guard: ${problem}`)
        }
      } catch (e: any) {
        if (String(e?.message || "").includes("Crucible guard")) throw e
      }
    },

    async "experimental.session.compacting"(input: any, output: any) {
      try {
        const sid = input?.sessionID
        if (!sid) return
        const slug = await resolveSlug(directory, undefined, sid)
        if (!slug) return
        const state = await readState(directory, slug)
        if (!state) return
        const role = Object.entries(state.sessions || {}).find(([, id]) => id === sid)?.[0]
        const open = state.open_findings
          .filter((f: any) => !["resolved", "accepted_risk"].includes(f.status))
          .map((f: any) => f.id)
        output.context.push(
          `Crucible run '${slug}' (${state.system})${role ? `, you are its ${role}` : ""}: phase=${state.phase}, round=${state.round}, revision=${state.design_revision}, design_dir=${relDesignDir(directory, slug)}, coverage_gaps=[${state.coverage.gaps.join(", ")}], open_findings=[${open.join(", ")}]. Keep this run active; do not re-elicit requirements after compaction.`,
        )
      } catch {
      }
    },

    async dispose() {
      disposed = true
      killMarked(`CRUCIBLE_WORKTREE=${directory}`)
      // A re-created instance for this worktree recovers its runs again.
      recoveredDirs.delete(directory)
      // Only this instance's watchdogs: other instances in the process keep theirs.
      for (const [id, w] of [...watchdogs]) if (path.resolve(w.dir) === directory) watchdogs.delete(id)
      if (watchdogs.size === 0) stopWatchdogSweeper()
    },
  }
}
