import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Crucible TUI status panel: lists this worktree's runs and marks the session's current one.

type Child = string | number | boolean | null | undefined | object | (() => Child)

function element(tag: string, props: Record<string, unknown>, children: Child[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}
const text = (props: Record<string, unknown>, children: Child[]) => element("text", props, children)
const box = (props: Record<string, unknown>, children: Child[] = []) => element("box", props, children)

function dataDir() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode-crucible")
}

function dirExists(directory: string) {
  try {
    return statSync(directory).isDirectory()
  } catch {
    return false
  }
}

// The run layout is <worktree>/docs/design/<slug>; a monorepo may keep it in an immediate subdirectory.
function designRoots(directory: string): string[] {
  const roots: string[] = []
  const direct = join(directory, "docs", "design")
  if (dirExists(direct)) roots.push(direct)
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const nested = join(directory, entry.name, "docs", "design")
      if (dirExists(nested)) roots.push(nested)
    }
  } catch {
  }
  return roots
}

function runStateFile(designRoot: string, slug: string) {
  return join(designRoot, slug, ".crucible", "state.json")
}

// The design root that actually holds this slug's state, or null.
function findRunRoot(directory: string, slug: string): string | null {
  for (const root of designRoots(directory)) {
    try {
      statSync(runStateFile(root, slug))
      return root
    } catch {
    }
  }
  return null
}

function currentSlug(directory: string, sessionID: string) {
  try {
    const reg = JSON.parse(readFileSync(join(dataDir(), "sessions.json"), "utf8"))
    const entry = reg?.[sessionID]
    if (!entry) return null
    const runs = entry.runs || {}
    const candidates: string[] = [entry.current, entry.slug, ...Object.keys(runs)].filter(Boolean)
    for (const slug of candidates) {
      const dir = runs[slug]?.dir || directory
      if (findRunRoot(dir, slug) || findRunRoot(directory, slug)) return slug
    }
    return null
  } catch {
    return null
  }
}

function registryDirs(sessionID: string) {
  try {
    const reg = JSON.parse(readFileSync(join(dataDir(), "sessions.json"), "utf8"))
    const entry = reg?.[sessionID]
    const dirs = new Set<string>()
    if (entry?.runs) {
      for (const meta of Object.values(entry.runs) as any[]) if (meta?.dir) dirs.add(String(meta.dir))
    }
    return [...dirs]
  } catch {
    return [] as string[]
  }
}

type Run = { slug: string; state: any; mtime: number }

function runs(directory: string): Run[] {
  const out: Run[] = []
  for (const root of designRoots(directory)) {
    let slugs: string[] = []
    try {
      slugs = readdirSync(root)
    } catch {
      continue
    }
    for (const slug of slugs) {
      const file = runStateFile(root, slug)
      try {
        const st = statSync(file)
        const parsed = JSON.parse(readFileSync(file, "utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
        out.push({ slug, state: parsed, mtime: st.mtimeMs })
      } catch {
      }
    }
  }
  return out
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const TERMINAL = new Set([
  "converged",
  "accepted_with_reservations",
  "budget_stopped",
  "no_progress",
  "stopped",
  "blocked",
])
// A dispatched turn with no activity longer than the run's watchdog window is shown as stalled.
const STALL_MS = (() => {
  const n = Number(process.env.CRUCIBLE_WATCHDOG_MS)
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000
})()

type Activity = { icon: string; label: string }

function escalations(s: any): any[] {
  if (Array.isArray(s.escalations) && s.escalations.length) return s.escalations
  return s.escalation ? [s.escalation] : []
}

function needsYou(s: any): boolean {
  return escalations(s).some((e: any) => e?.status === "pending_user_ratification")
}

// Liveness of a run: is an agent actually working, stalled, waiting, or done?
function activity(s: any, frame: string): Activity {
  if (TERMINAL.has(s.phase)) return { icon: "■", label: s.phase }
  if (s.paused) return { icon: "⏸", label: "paused" }
  if (needsYou(s)) return { icon: "!", label: "needs you" }
  const d = s.dispatch
  if (d) {
    // The plugin persists a coarse heartbeat while the turn streams, so an active turn is not stalled.
    const window = Number(s.watchdog_ms) > 0 ? Number(s.watchdog_ms) : STALL_MS
    const lastSign = Date.parse(d.last_activity_at || "") || Date.parse(d.started_at || "") || Date.parse(s.updated_at || "") || 0
    if (lastSign && Date.now() - lastSign > window) return { icon: "⚠", label: `${d.role} stalled` }
    const retry = Number(d.retries) > 0 ? ` (retry ${d.retries})` : ""
    return { icon: frame, label: `${d.role}${retry} · r${d.round ?? s.round}` }
  }
  if (s.phase === "eliciting") return { icon: "·", label: "awaiting you" }
  if (s.phase === "awaiting_decomposition") return { icon: "·", label: "awaiting confirm" }
  return { icon: "·", label: "waiting" }
}

// Mirrors the plugin's gate: binding blockers/majors, plus contested ones awaiting the user.
function gating(f: any) {
  if (f?.severity !== "blocker" && f?.severity !== "major") return false
  return f.status === "binding" || (f.status === "needs_adjudication" && f.contested === true)
}

function summary(run: Run, frame: string) {
  const s = run.state
  const a = activity(s, frame)
  const findings: any[] = Array.isArray(s.open_findings) ? s.open_findings : []
  const open = findings.filter((f: any) => !["resolved", "accepted_risk"].includes(f?.status))
  const gate = open.filter(gating).length
  const history: any[] = Array.isArray(s.history) ? s.history : []
  const last = history[history.length - 1]
  const flags = `${s.paused ? " · paused" : ""}${needsYou(s) ? " · NEEDS YOU" : ""}`
  // A decompose root's integration rounds have their own budget.
  const base = Number(s.integration_base_round) > 0 ? Number(s.integration_base_round) : 0
  const budget = `${base ? "integration " : ""}${(s.round ?? 0) - base}/${s.budgets?.max_rounds ?? "?"}`
  return {
    head: `${a.icon} ${s.phase} · r${s.round} · ${s.design_revision}${flags}`,
    detail: `${a.label} · ${s.budgets?.mode ?? "?"} ${budget} · score ${last ? last.score : "-"} · open ${open.length} · gate ${gate}`,
  }
}

function Sidebar(api: TuiPluginApi, sessionID: string) {
  const theme = api.theme.current
  const directory = api.state?.path?.directory || api.state?.path?.worktree || process.cwd()

  // File reads happen on the slow poll; the spinner runs off its own fast tick.
  const refresh = () => {
    try {
      const cur = currentSlug(directory, sessionID)
      // Include the dirs this session is bound to, bound dirs first.
      const dirs = Array.from(new Set([...registryDirs(sessionID), directory]))
      const bySlug = new Map<string, Run>()
      for (const d of dirs) for (const r of runs(d)) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r)
      const sorted = [...bySlug.values()].sort((a, b) => {
        const ar = a.state.parent_slug || a.slug
        const br = b.state.parent_slug || b.slug
        if (ar !== br) return ar < br ? -1 : 1
        if (a.slug === ar && b.slug !== br) return -1
        if (b.slug === br && a.slug !== ar) return 1
        return b.mtime - a.mtime
      })
      const window = sorted.slice(0, 6)
      // Keep the current run visible even if more than 6 runs push it out.
      if (cur && !window.some((r) => r.slug === cur)) {
        const curRun = sorted.find((r) => r.slug === cur)
        if (curRun) {
          if (window.length) window[window.length - 1] = curRun
          else window.push(curRun)
        }
      }
      return { cur, all: window }
    } catch {
      return { cur: null as string | null, all: [] as Run[] }
    }
  }

  const [data, setData] = createSignal(refresh())
  const [spin, setSpin] = createSignal(0)
  const poll = setInterval(() => setData(refresh()), 2000)
  const anim = setInterval(() => setSpin((v) => v + 1), 120)
  onCleanup(() => {
    clearInterval(poll)
    clearInterval(anim)
  })
  const frame = () => SPINNER[spin() % SPINNER.length]

  const children: Child[] = [text({ fg: theme.text }, ["Crucible"])]
  for (let i = 0; i < 6; i++) {
    children.push(
      text({ fg: theme.textMuted }, [
        () => {
          const d = data()
          const r = d.all[i]
          if (!r) return ""
          const indent = r.state.parent_slug ? "  └ " : "  "
          const marker = r.slug === d.cur ? "▸ " : indent
          const need = needsYou(r.state) ? "! " : ""
          return `${marker}${need}${r.slug} · ${summary(r, frame()).head}`
        },
      ]),
    )
    children.push(
      text({ fg: theme.textMuted }, [
        () => {
          const d = data()
          const r = d.all[i]
          if (!r || r.slug !== d.cur) return ""
          return `   ${summary(r, frame()).detail}`
        },
      ]),
    )
  }
  return box({ flexDirection: "column" }, children)
}

const tui: TuiPlugin = async (api) => {
  try {
    api.slots.register({
      order: 130,
      slots: {
        sidebar_content(_ctx: any, props: any) {
          return Sidebar(api, props.session_id)
        },
      },
    })
  } catch {
    // sidebar is best-effort; never break the TUI
  }
}

const plugin: TuiPluginModule = { id: "opencode-crucible.tui", tui }

export { tui }
export default plugin
