// Pure run grouping and sidebar visibility. Kept apart from tui.ts so it can be tested
// without the OpenTUI runtime. Nothing here reads or writes design files.

export const TERMINAL = new Set([
  "converged",
  "accepted_with_reservations",
  "budget_stopped",
  "no_progress",
  "stopped",
  "blocked",
])

export type Run = { slug: string; state: any; mtime: number }

export type Effort = {
  root: string
  runs: Run[]
  rootRun: Run | undefined
  mtime: number
}

export type Visibility = Record<string, "show" | "hide">

export function escalations(s: any): any[] {
  if (Array.isArray(s?.escalations) && s.escalations.length) return s.escalations
  return s?.escalation ? [s.escalation] : []
}

// "Needs you" means the Referee question was actually delivered, not merely that a
// decision may be required. An undelivered escalation is retried by the server.
export function needsYou(s: any): boolean {
  return escalations(s).some((e: any) => e?.status === "pending_user_ratification" && e?.notified === true)
}

export function deliveryPending(s: any): boolean {
  return escalations(s).some((e: any) => e?.status === "pending_user_ratification" && e?.notified !== true)
}

export function isTerminal(run: Run) {
  return TERMINAL.has(run.state?.phase)
}

// The inactivity window the plugin is actually enforcing. It persists the larger
// tool window in the dispatch, so the badge does not call a run stalled early.
export function inactivityWindow(state: any, fallback: number) {
  const dispatch = Number(state?.dispatch?.watchdog_ms)
  if (Number.isFinite(dispatch) && dispatch > 0) return dispatch
  const run = Number(state?.watchdog_ms)
  if (Number.isFinite(run) && run > 0) return run
  return fallback
}

// A decomposition is one effort: root run plus its subsystem runs. A child whose root
// state is missing still groups under the parent slug it names.
export function groupEfforts(runs: Run[]): Effort[] {
  const byRoot = new Map<string, Effort>()
  for (const run of runs) {
    const root = String(run.state?.parent_slug || run.slug)
    let effort = byRoot.get(root)
    if (!effort) {
      effort = { root, runs: [], rootRun: undefined, mtime: 0 }
      byRoot.set(root, effort)
    }
    effort.runs.push(run)
    if (run.slug === root) effort.rootRun = run
    effort.mtime = Math.max(effort.mtime, run.mtime)
  }
  for (const effort of byRoot.values()) {
    effort.runs.sort((a, b) => {
      if (a.slug === effort.root) return -1
      if (b.slug === effort.root) return 1
      return b.mtime - a.mtime
    })
  }
  return [...byRoot.values()]
}

// The run that best represents an effort: something needing the user, else something
// still running, else the root, else any child.
export function effortLead(effort: Effort): Run {
  return (
    effort.runs.find((r) => needsYou(r.state)) ||
    effort.runs.find((r) => deliveryPending(r.state)) ||
    effort.runs.find((r) => !isTerminal(r)) ||
    effort.rootRun ||
    effort.runs[0]
  )
}

// Current effort first, then delivered questions, then undelivered questions, then the
// most recently touched. An undelivered question still needs the user to look at it.
export function sortEfforts(efforts: Effort[], currentSlug: string | null): Effort[] {
  const rank = (effort: Effort) => {
    if (currentSlug && effort.runs.some((r) => r.slug === currentSlug)) return 0
    if (effort.runs.some((r) => needsYou(r.state))) return 1
    if (effort.runs.some((r) => deliveryPending(r.state))) return 2
    return 3
  }
  return [...efforts].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)
}

export function currentEffort(efforts: Effort[], currentSlug: string | null): Effort | undefined {
  if (!currentSlug) return
  return efforts.find((e) => e.runs.some((r) => r.slug === currentSlug))
}

// Declared subsystems count even before their state files exist; live means started
// and not terminal.
export function subsystemCounts(effort: Effort) {
  const declared = Array.isArray(effort.rootRun?.state?.subsystems) ? effort.rootRun.state.subsystems.length : 0
  const started = effort.runs.length - (effort.rootRun ? 1 : 0)
  return {
    total: Math.max(declared, started),
    live: effort.runs.filter((r) => r.slug !== effort.root && !isTerminal(r)).length,
  }
}

// Auto: the current effort and any effort with live work are shown, settled efforts are
// hidden. An explicit show/hide from the manager always wins, so an old design can be
// brought back without touching its files.
export function isVisible(effort: Effort, currentSlug: string | null, prefs: Visibility): boolean {
  const pref = prefs[effort.root]
  if (pref === "hide") return false
  if (pref === "show") return true
  if (currentSlug && effort.runs.some((r) => r.slug === currentSlug)) return true
  return effort.runs.some((r) => !isTerminal(r) || needsYou(r.state) || deliveryPending(r.state))
}

export function partitionEfforts(efforts: Effort[], currentSlug: string | null, prefs: Visibility) {
  const sorted = sortEfforts(efforts, currentSlug)
  const visible = sorted.filter((effort) => isVisible(effort, currentSlug, prefs))
  return { visible, hidden: sorted.length - visible.length }
}

// "root--child" -> "child" for the compact sidebar.
export function shortName(effort: Effort, slug: string) {
  const prefix = `${effort.root}--`
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug
}

// A narrow-sidebar label: drop the suite prefix and the v0.1 suffix, and use the
// child name for a subsystem. "engineering-compiler-proving-ground-v0-1" -> "proving-ground".
export function displayName(slug: string) {
  let name = String(slug || "")
  const child = name.lastIndexOf("--")
  if (child >= 0) name = name.slice(child + 2)
  name = name.replace(/^engineering-compiler-/, "")
  name = name.replace(/-v\d+(?:[.-]\d+)*$/, "")
  if (!name || name === "v0-1" || name === "v0.1") return "core"
  return name
}
