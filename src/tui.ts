import type { Plugin } from "@opencode/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  TERMINAL,
  currentEffort,
  displayName,
  effortLead,
  groupEfforts,
  inactivityWindow,
  isVisible,
  needsYou,
  deliveryPending,
  partitionEfforts,
  sortEfforts,
  subsystemCounts,
  type Effort,
  type Run,
  type Visibility,
} from "./tui-runs.ts"

// Crucible TUI status panel: groups this worktree's runs by design, marks the session's
// current one, and manages show/hide preferences that never touch the design files.

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
// A dispatched turn with no activity longer than the run's watchdog window is shown as stalled.
const STALL_MS = (() => {
  const n = Number(process.env.CRUCIBLE_WATCHDOG_MS)
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000
})()

type Activity = { icon: string; label: string }

// Liveness of a run: is an agent actually working, stalled, waiting, or done?
function activity(s: any, frame: string): Activity {
  if (TERMINAL.has(s.phase)) return { icon: "■", label: s.phase }
  if (s.paused) return { icon: "⏸", label: "paused" }
  if (needsYou(s)) return { icon: "!", label: "needs you" }
  const d = s.dispatch
  if (d) {
    // The plugin persists a coarse heartbeat while the turn streams and the larger window
    // it is actually using while a tool runs, so an active turn is not shown as stalled.
    const window = inactivityWindow(s, STALL_MS)
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
  const flags = `${s.paused ? " · paused" : ""}${needsYou(s) ? " · NEEDS YOU" : ""}${deliveryPending(s) ? " · delivery pending" : ""}`
  // A decompose root's integration rounds have their own budget.
  const base = Number(s.integration_base_round) > 0 ? Number(s.integration_base_round) : 0
  const budget = `${base ? "integration " : ""}${(s.round ?? 0) - base}/${s.budgets?.max_rounds ?? "?"}`
  return {
    head: `${a.icon} ${s.phase} · r${s.round} · ${s.design_revision}${flags}`,
    detail: `${a.label} · ${s.budgets?.mode ?? "?"} ${budget} · score ${last ? last.score : "-"} · open ${open.length} · gate ${gate}`,
  }
}

// Include the dirs this session is bound to, then this worktree. A slug is listed once.
function collectRuns(directory: string, sessionID: string | undefined): Run[] {
  const dirs = Array.from(new Set([...(sessionID ? registryDirs(sessionID) : []), directory]))
  const bySlug = new Map<string, Run>()
  for (const d of dirs) for (const r of runs(d)) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r)
  return [...bySlug.values()]
}

type SidebarData = {
  cur: string | null
  currentRoot: string | null
  efforts: Effort[]
  hidden: number
}

function Sidebar(context: any, sessionID: string, visibility: any) {
  const theme = context.theme
  const directory = context.location?.directory || process.cwd()
  const prefs = () => (visibility?.[directory] || {}) as Visibility

  // File reads happen on the slow poll; the spinner runs off its own fast tick.
  const refresh = (): SidebarData => {
    try {
      const cur = currentSlug(directory, sessionID)
      const efforts = groupEfforts(collectRuns(directory, sessionID))
      const { visible, hidden } = partitionEfforts(efforts, cur, prefs())
      return {
        cur,
        currentRoot: currentEffort(efforts, cur)?.root ?? null,
        efforts: visible,
        hidden,
      }
    } catch {
      return { cur: null, currentRoot: null, efforts: [], hidden: 0 }
    }
  }

  const [data, setData] = createSignal(refresh())
  const [spin, setSpin] = createSignal(0)
  createEffect(() => {
    // Repaint as soon as this worktree's show/hide preferences change.
    void visibility?.[directory]
    setData(refresh())
  })
  const poll = setInterval(() => setData(refresh()), 2000)
  const anim = setInterval(() => setSpin((v) => v + 1), 120)
  onCleanup(() => {
    clearInterval(poll)
    clearInterval(anim)
  })
  const frame = () => SPINNER[spin() % SPINNER.length]

  // A panel with a focus area, a tree list and section rules:
  //   header / rule / current design / rule / other designs / rule / command.
  // Every line is single-line and width-constrained; nothing wraps.
  const lines = () => {
    const d = data()
    const f = frame()
    const out: string[] = []
    const RULE = "─".repeat(32)
    const status = (run: Run) => {
      const a = activity(run.state, f)
      const phase = String(run.state.phase || "?")
      return a.label === phase ? phase : `${phase} · ${a.label}`
    }
    const compactStatus = (run: Run) => {
      const s = run.state
      if (needsYou(s)) return "needs you"
      if (deliveryPending(s)) return "delivery pending"
      if (s.paused) return "paused"
      const phase = String(s.phase || "?")
      if (phase === "converged" || phase === "accepted_with_reservations") return "done"
      if (phase === "designing") return s.dispatch ? "working" : "waiting"
      if (phase === "responding" || phase === "falsifying" || phase === "verifying") return "review"
      if (phase === "eliciting") return "awaiting you"
      if (phase === "awaiting_decomposition") return "confirm"
      return phase.replaceAll("_", " ")
    }
    const metrics = (run: Run) => {
      const s = run.state
      const base = Number(s.integration_base_round) > 0 ? Number(s.integration_base_round) : 0
      const round = `${base ? "int " : ""}${(s.round ?? 0) - base}/${s.budgets?.max_rounds ?? "?"}`
      const open = (Array.isArray(s.open_findings) ? s.open_findings : []).filter(
        (x: any) => !["resolved", "accepted_risk"].includes(x?.status),
      ).length
      const gate = (Array.isArray(s.open_findings) ? s.open_findings : []).filter(
        (x: any) => gating(x) && !["resolved", "accepted_risk"].includes(x?.status),
      ).length
      return [
        `${s.budgets?.mode ?? "?"} · round ${round}`,
        open ? `${open} open` : "",
        gate ? `${gate} gate` : "",
      ].filter(Boolean).join(" · ")
    }
    out.push(RULE)
    d.efforts.forEach((effort, index) => {
      const last = index === d.efforts.length - 1
      const branch = last ? "└─ " : "├─ "
      const rail = last ? "   " : "│  "
      const current = d.cur ? effort.runs.find((r) => r.slug === d.cur) : undefined
      const need = effort.runs.some((r) => needsYou(r.state)) ? "! " : ""
      const marker = effort.root === d.currentRoot ? "▸ " : ""
      const who = current && current.slug !== effort.root ? ` › ${displayName(current.slug)}` : ""
      const subs = subsystemCounts(effort)
      const rollup = subs.total ? ` · ${subs.live}/${subs.total} live` : ""
      out.push(`${branch}${marker}${need}${displayName(effort.root)}${who}${rollup}`)
      if (current) {
        out.push(`${rail}${status(current)}`)
        out.push(`${rail}${metrics(current)}`)
      } else {
        const lead = effortLead(effort)
        const from = lead.slug !== effort.root ? `${displayName(lead.slug)} · ` : ""
        out.push(`${rail}${from}${status(lead)}`)
      }

      // A decomposed run is a tree: show every subsystem run and its state.
      const kids = effort.runs.filter((r) => r.slug !== effort.root)
      kids.forEach((child, childIndex) => {
        const lastChild = childIndex === kids.length - 1
        const childBranch = lastChild ? "└─ " : "├─ "
        const childNeed = needsYou(child.state) ? "! " : ""
        const childMarker = d.cur === child.slug ? "▸ " : ""
        out.push(`${rail}${childBranch}${childMarker}${childNeed}${displayName(child.slug)} · ${compactStatus(child)}`)
      })
      if (index < d.efforts.length - 1) out.push(RULE)
    })
    if (!d.efforts.length) out.push("  no active designs")
    out.push(RULE)
    const foot = d.hidden > 0 ? ` · ${d.hidden} hidden` : ""
    out.push(`/crucible${foot}`)
    return out
  }

  const lineProps = { fg: theme.text.muted, wrapMode: "none" as const, truncate: true, width: "100%" as const }
  return box({ flexDirection: "column", width: "100%" }, [
    text({ fg: theme.text.base, wrapMode: "none" as const, truncate: true, width: "100%" as const }, ["Crucible"]),
    // One multiline text node lets the sidebar's scrollbar own vertical overflow;
    // there is no artificial row cap.
    text(lineProps, [() => lines().join("\n")]),
  ])
}

// The show/hide manager. Visibility is TUI state only; selecting an option never
// deletes or moves a design directory.
async function manageDesigns(context: any, visibility: any, save: (mutation: (draft: any) => void) => Promise<void>) {
  const directory = context.location?.directory || process.cwd()
  const route = (() => {
    try {
      return context.ui.router.current()
    } catch {
      return null
    }
  })()
  const sessionID = route?.type === "session" ? route.sessionID : undefined
  const SHOW_ALL = "\u0000show-all"

  for (;;) {
    const runList = collectRuns(directory, sessionID)
    if (!runList.length) {
      context.ui.toast.show({ title: "Crucible", message: "No designs in this worktree", variant: "info" })
      return
    }
    const cur = currentSlug(directory, sessionID)
    const efforts = sortEfforts(groupEfforts(runList), cur)
    const prefs = (visibility?.[directory] || {}) as Visibility
    const shown = new Map(efforts.map((effort) => [effort.root, isVisible(effort, cur, prefs)]))
    const hidden = efforts.filter((effort) => !shown.get(effort.root)).length
    const current = currentEffort(efforts, cur)?.root
    const options: Array<{ title: string; value: string; description: string; footer?: string; category: string }> = efforts.map((effort) => {
      const visible = shown.get(effort.root) === true
      const subs = subsystemCounts(effort)
      return {
        title: `${visible ? "●" : "○"} ${effort.root}`,
        value: effort.root,
        description: `${summary(effortLead(effort), "·").head}${subs.total ? ` · ${subs.live}/${subs.total} subs live` : ""}`,
        footer: visible ? undefined : "hidden — design files kept",
        category: effort.root === current && visible ? "Current" : visible ? "Shown" : "Hidden",
      }
    })
    if (hidden) {
      options.push({
        title: "Show all hidden designs",
        value: SHOW_ALL,
        description: `${hidden} hidden · design files stay on disk`,
        category: "Actions",
      })
    }

    let choice: string | undefined
    try {
      choice = await context.ui.dialog.select({
        title: "Crucible designs",
        placeholder: "Show or hide in the sidebar — design files stay on disk",
        options,
        current,
      })
    } catch {
      return
    }
    if (!choice) return

    try {
      if (choice === SHOW_ALL) {
        await save((draft) => {
          const own = draft[directory] || (draft[directory] = {})
          for (const effort of efforts) if (!shown.get(effort.root)) own[effort.root] = "show"
        })
        continue
      }
      const visible = shown.get(choice)
      if (visible === undefined) continue
      const next = visible ? "hide" : "show"
      await save((draft) => {
        const own = draft[directory] || (draft[directory] = {})
        own[choice] = next
      })
      context.ui.toast.show({
        title: "Crucible",
        message: `${next === "hide" ? "Hidden" : "Shown"} ${choice} · design files kept`,
        duration: 2000,
      })
    } catch {
      return
    }
  }
}

// Every server notice for this worktree becomes a toast. V2 has no server-side toast API,
// so the server appends notices to a JSONL file and this tails it.
function watchNotifications(context: any) {
  const file = join(dataDir(), "notifications.jsonl")
  const directory = context.location?.directory
  let seen = -1
  const tick = () => {
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
      // First look (or a rotated file) establishes the baseline without replaying history.
      if (seen < 0 || seen > lines.length) seen = lines.length
      for (; seen < lines.length; seen++) {
        const notice = JSON.parse(lines[seen])
        if (directory && notice?.dir && notice.dir !== directory) continue
        context.ui.toast.show({ title: "Crucible", message: String(notice?.message || ""), variant: notice?.variant || "info", duration: 6000 })
      }
    } catch {
      // no notice file yet
    }
  }
  const timer = setInterval(tick, 2000)
  tick()
  return () => clearInterval(timer)
}

const plugin = {
  id: "opencode-crucible.tui",
  setup(context: Plugin.Context) {
    const disposers: Array<() => void> = []
    // Durable TUI-only state, keyed by worktree. Design files are never touched.
    let visibility: any = {}
    let saveVisibility: ((mutation: (draft: any) => void) => Promise<void>) | undefined
    try {
      if (context.storage?.store) {
        const [store, save] = context.storage.store<Record<string, Visibility>>("crucible.visibility", { initial: {} })
        visibility = store
        saveVisibility = save
      }
    } catch {
      // no durable storage: the sidebar still works with automatic visibility
    }
    try {
      disposers.push(context.ui.slot({ append: "sidebar.content", render: ({ sessionID }) => Sidebar(context, sessionID, visibility) }))
    } catch {
      // sidebar is best-effort; never break the TUI
    }
    if (saveVisibility) {
      const save = saveVisibility
      try {
        // keymap.layer needs a Solid component owner, so the layer lives in an app slot.
        disposers.push(
          context.ui.slot({
            append: "app",
            render: () => {
              context.keymap.layer(() => ({
                mode: "global",
                commands: [
                  {
                    id: "crucible.designs",
                    title: "Crucible designs",
                    description: "Show or hide designs in the sidebar (design files are kept)",
                    group: "Crucible",
                    palette: true,
                    slash: { name: "crucible" },
                    run: () => {
                      void manageDesigns(context, visibility, save).catch((error) => {
                        context.ui.toast.show({ title: "Crucible", message: String(error?.message || error), variant: "error", duration: 4000 })
                      })
                    },
                  },
                ],
              }))
              return null as any
            },
          }),
        )
      } catch {
        // command registration is best-effort
      }
    }
    const stopNotices = watchNotifications(context)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
        }
      }
      stopNotices()
    }
  },
}

export default plugin
