import { test, expect, afterAll } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// End-to-end plugin tests with a fake SDK client and a temp worktree (no opencode, no live agents).
const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "crucible-data-"))
process.env.XDG_DATA_HOME = dataHome
afterAll(async () => {
  await fs.rm(dataHome, { recursive: true, force: true })
})

const serverModule = await import("../src/server")
const { server } = serverModule
const { drainEvents } = await import("../src/events")

// opencode calls every function the plugin module exports as a plugin factory.
test("the server module exports only the plugin factory", () => {
  expect(Object.keys(serverModule)).toEqual(["server"])
})

// The fake SDK client: failed calls return { error } instead of throwing.
function makeClient(opts: { promptError?: (args: any) => any; status?: () => any } = {}) {
  let n = 0
  const prompts: any[] = []
  const aborts: any[] = []
  const session: any = {
    async create() {
      return { data: { id: `ses_${++n}` } }
    },
    async promptAsync(args: any) {
      prompts.push(args)
      const error = opts.promptError?.(args)
      return error ? { error } : { data: undefined }
    },
    async update() {
      return { data: undefined }
    },
    async abort(args: any) {
      aborts.push(args)
      return { data: undefined }
    },
    async messages() {
      return { data: [] }
    },
  }
  if (opts.status) session.status = async () => ({ data: opts.status!() })
  return {
    prompts,
    aborts,
    session,
    tui: {
      async showToast() {
        return { data: true }
      },
    },
  }
}

async function readState(dir: string, slug: string) {
  return JSON.parse(await fs.readFile(path.join(dir, "docs", "design", slug, ".crucible", "state.json"), "utf8"))
}
async function writeState(dir: string, slug: string, state: any) {
  await fs.writeFile(path.join(dir, "docs", "design", slug, ".crucible", "state.json"), JSON.stringify(state, null, 2))
}

const fullCov = {
  dimensions: ["requirements", "security", "scale", "cost", "operability", "failure", "data", "evolvability"],
  examined: ["requirements", "security", "scale", "cost", "operability", "failure", "data", "evolvability"],
  gaps: [],
}
const cleanVerdict = (round: number, coverage: any) =>
  JSON.stringify({ round, verdict: "accepted", findings: [], coverage, no_new_falsifiable_claim: true })
const findingsVerdict = (round: number, ids: string[]) =>
  JSON.stringify({
    round,
    verdict: "changes_required",
    findings: ids.map((id) => ({
      id,
      severity: "major",
      category: "security",
      claim: "c",
      counterexample: "x",
      evidence: { class: "authoritative", verification: "verified" },
      requirement_ids: ["R-001"],
      artifact_ref: "03-architecture.md#x",
      action: "open",
    })),
    coverage: fullCov,
    no_new_falsifiable_claim: false,
  })

async function harness(options: any = {}, clientOpts: any = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crucible-work-"))
  const client = makeClient(clientOpts)
  const hooks: any = await server({ client, directory: dir }, options)
  const ctx = { sessionID: `ses_${Math.random().toString(36).slice(2)}`, directory: dir, messageID: "m", agent: "crucible", worktree: dir }
  const call = (name: string, args: any) => hooks.tool[name].execute(args, ctx)
  // Call a tool as another session (e.g. a dispatched child agent).
  const callAs = (sessionID: string) => (name: string, args: any) => hooks.tool[name].execute(args, { ...ctx, sessionID })
  // Deliver a bus event and wait until the plugin has handled it.
  const emit = async (event: any) => {
    await hooks.event({ event })
    await drainEvents()
  }
  const j = (s: string) => JSON.parse(s)
  return { dir, client, hooks, ctx, call, callAs, emit, j }
}

test("design_protocol returns the in-code protocol", async () => {
  const { dir, hooks, call } = await harness()
  try {
    const p = await call("design_protocol", {})
    expect(String(p)).toContain("Crucible Protocol")
    expect(String(p)).toContain("Validation ladder")
    expect(String(p).length).toBeGreaterThan(500)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("2-subsystem decompose: hold, create, pump, release, block", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    // --- root design round, then the pre-decomposition hold ---
    expect(j(await call("design_start", { system: "Bank", brief: "b", slug: "bank", mode: "fast", decompose: true })).ok).toBe(true)
    await call("design_add_requirement", { slug: "bank", text: "System req", priority: "must" })
    await call("design_confirm_requirements", { slug: "bank" })
    await call("design_respond", { slug: "bank", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "bank" })
    await call("design_submit_verdict", { slug: "bank", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "bank", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    expect((await readState(dir, "bank")).phase).toBe("awaiting_decomposition")

    // --- decompose into two subsystems (ledger depends on payments) ---
    const reqs = (ns: string) => [{ id: `${ns}-R-001`, text: "subsystem req", priority: "must", system_reqs: ["R-001"] }]
    const manifest = {
      system_slug: "bank",
      version: 1,
      subsystems: [
        { name: "payments", namespace: "PAY", title: "Payments", required: true, depends_on: [], domains: ["security", "data"], mode: "fast", requirements: reqs("PAY"), provides: ["POST /payments"], requires: [] },
        { name: "ledger", namespace: "LED", title: "Ledger", required: true, depends_on: ["payments"], domains: ["data"], mode: "fast", requirements: reqs("LED"), provides: ["LedgerClient.postEntry"], requires: ["POST /payments"] },
      ],
      // ledger consumes the contract payments provides.
      interfaces: [{ from: "payments", to: "ledger", contract: "POST /payments", system_reqs: ["R-001"] }],
      traceability: [{ system_req: "R-001", subsystems: ["payments", "ledger"], subsystem_reqs: ["PAY-R-001", "LED-R-001"] }],
    }
    const dep = j(await call("design_decompose", { slug: "bank", decomposition_json: JSON.stringify(manifest) }))
    expect(dep.ok).toBe(true)
    expect(dep.subsystems).toEqual(["bank--payments", "bank--ledger"])
    expect(dep.traceability_gaps).toEqual([])

    let root = await readState(dir, "bank")
    expect(root.children.length).toBe(2)
    expect(root.waiting_on.sort()).toEqual(["bank--ledger", "bank--payments"])
    const payA = await readState(dir, "bank--payments")
    const ledA = await readState(dir, "bank--ledger")
    expect(payA.namespace).toBe("PAY")
    expect(payA.effort).toBe("bank")
    expect(payA.phase).toBe("designing")
    expect(payA.dispatch).toBeTruthy() // pumped: dependency-free child started
    expect(ledA.dispatch).toBeFalsy() // held: depends_on payments

    // --- root rejects a subsystem via subsystem_ref, then clears on resolve ---
    await call("design_begin_round", { slug: "bank" })
    const blockVerdict = {
      round: 2,
      verdict: "changes_required",
      findings: [
        { id: "F-1", severity: "major", category: "security", claim: "interface mismatch", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", subsystem_ref: "payments", action: "open" },
      ],
      coverage: fullCov,
      no_new_falsifiable_claim: false,
    }
    await call("design_submit_verdict", { slug: "bank", verdict_json: JSON.stringify(blockVerdict) })
    expect((await readState(dir, "bank--payments")).acceptance_blocked_by_parent).toBe("F-1")
    await call("design_respond", { slug: "bank", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [{ finding_id: "F-1", disposition: "fix", rationale: "resolved" }] }) })
    expect((await readState(dir, "bank--payments")).acceptance_blocked_by_parent).toBe(null)

    // --- drive payments to converged (two clean rounds) ---
    const childCov = { dimensions: ["security", "data"], examined: ["security", "data"], gaps: [] }
    await call("design_respond", { slug: "bank--payments", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "bank--payments" })
    await call("design_submit_verdict", { slug: "bank--payments", verdict_json: cleanVerdict(1, childCov) })
    await call("design_respond", { slug: "bank--payments", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_begin_round", { slug: "bank--payments" })
    await call("design_submit_verdict", { slug: "bank--payments", verdict_json: cleanVerdict(2, childCov) })
    await call("design_respond", { slug: "bank--payments", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })

    expect((await readState(dir, "bank--payments")).phase).toBe("converged")
    root = await readState(dir, "bank")
    expect(root.children.find((c: any) => c.slug === "bank--payments").phase).toBe("converged")
    expect((await readState(dir, "bank--ledger")).dispatch).toBeTruthy() // released once its dependency was accepted

    // --- a required child that terminates unaccepted blocks the root ---
    const ledC = await readState(dir, "bank--ledger")
    ledC.phase = "budget_stopped"
    await writeState(dir, "bank--ledger", ledC)
    await call("design_decompose", { slug: "bank", decomposition_json: JSON.stringify(manifest) }) // idempotent re-ingest refreshes children
    await call("design_dispatch", { slug: "bank" })
    expect((await readState(dir, "bank")).phase).toBe("blocked")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("plain run is unchanged (backward compatible, no decomposition)", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    expect(j(await call("design_start", { system: "Small", brief: "b", slug: "small", mode: "fast" })).ok).toBe(true)
    await call("design_add_requirement", { slug: "small", text: "Only req", priority: "must" })
    await call("design_confirm_requirements", { slug: "small" })
    await call("design_respond", { slug: "small", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    // two clean rounds -> converged (k=2), no hold, no subsystems
    await call("design_begin_round", { slug: "small" })
    await call("design_submit_verdict", { slug: "small", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "small", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    expect((await readState(dir, "small")).phase).toBe("designing")
    await call("design_begin_round", { slug: "small" })
    await call("design_submit_verdict", { slug: "small", verdict_json: cleanVerdict(2, fullCov) })
    await call("design_respond", { slug: "small", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })
    const st = await readState(dir, "small")
    expect(st.phase).toBe("converged")
    expect(st.decompose).toBe(false)
    expect(st.subsystems.length).toBe(0)
    expect(st.parent_slug).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const soloManifest = {
  system_slug: "solo",
  version: 1,
  subsystems: [
    { name: "svc", namespace: "SVC", title: "Svc", required: true, depends_on: [], domains: ["security"], mode: "fast", requirements: [{ id: "SVC-R-001", text: "r", priority: "must", system_reqs: ["R-001"] }], provides: [], requires: [] },
  ],
  interfaces: [],
  traceability: [{ system_req: "R-001", subsystems: ["svc"], subsystem_reqs: ["SVC-R-001"] }],
}

async function soloRoot(call: any, j: any, dir: string) {
  await call("design_start", { system: "Solo", brief: "b", slug: "solo", mode: "fast", decompose: true })
  await call("design_add_requirement", { slug: "solo", text: "sys", priority: "must" })
  await call("design_confirm_requirements", { slug: "solo" })
  await call("design_respond", { slug: "solo", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
  await call("design_begin_round", { slug: "solo" })
  await call("design_submit_verdict", { slug: "solo", verdict_json: cleanVerdict(1, fullCov) })
  await call("design_respond", { slug: "solo", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
}

async function convergeChild(call: any, slug: string, coverage: any) {
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
  await call("design_begin_round", { slug })
  await call("design_submit_verdict", { slug, verdict_json: cleanVerdict(1, coverage) })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
  await call("design_begin_round", { slug })
  await call("design_submit_verdict", { slug, verdict_json: cleanVerdict(2, coverage) })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })
}

test("root runs an integration round once its subsystem is accepted; rejection reopens it", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await soloRoot(call, j, dir)
    expect((await readState(dir, "solo")).phase).toBe("awaiting_decomposition")
    expect(j(await call("design_begin_round", { slug: "solo" })).ok).toBe(false) // hold cannot be skipped
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) })
    await convergeChild(call, "solo--svc", { dimensions: ["security"], examined: ["security"], gaps: [] })
    expect((await readState(dir, "solo--svc")).phase).toBe("converged")

    // the root was re-armed into its integration round
    let root = await readState(dir, "solo")
    expect(root.phase).toBe("falsifying")
    expect(root.dispatch).toBeTruthy()

    // the root rejects the (already accepted) subsystem -> it is reopened
    const rej = {
      round: root.round,
      verdict: "changes_required",
      findings: [{ id: "F-9", severity: "major", category: "security", claim: "iface", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", subsystem_ref: "svc", action: "open" }],
      coverage: fullCov,
      no_new_falsifiable_claim: false,
    }
    await call("design_submit_verdict", { slug: "solo", verdict_json: JSON.stringify(rej) })
    await call("design_respond", { slug: "solo", response_json: JSON.stringify({ round: root.round, design_revision: "v4", responses: [] }) })
    const svc = await readState(dir, "solo--svc")
    expect(svc.phase).toBe("falsifying") // reopened and re-dispatched (integration rejection)
    expect(svc.dispatch).toBeTruthy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("per-run configuration is recorded and applied to dispatch", async () => {
  const { dir, client, hooks, call } = await harness()
  try {
    const start = JSON.parse(await call("design_start", { system: "Cfg", brief: "b", slug: "cfg", preset: "deep", strict: true, architect_model: "openai/gpt-x", shell_policy: "allow", max_parallel: 2 }))
    expect(start.config.preset).toBe("deep")
    expect(start.config.strict).toBe(true)
    expect(start.config.models.architect).toBe("openai/gpt-x")
    expect(start.config.shellPolicy).toBe("allow")
    expect(start.config.max_parallel).toBe(2)

    await call("design_add_requirement", { slug: "cfg", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "cfg" })
    await call("design_dispatch", { slug: "cfg" }) // dispatches the Architect (initial design)

    const architect = (client.prompts as any[]).find((p) => p?.body?.agent === "architect")
    expect(architect.body.model).toEqual({ providerID: "openai", modelID: "gpt-x" })

    const st = await readState(dir, "cfg")
    expect(st.budgets.mode).toBe("deep")
    expect(st.allowAccepted).toBe(false)
    expect(st.shellPolicy).toBe("allow")
    expect(st.models.architect).toBe("openai/gpt-x")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_start seeds a drafted requirement ledger", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", {
      system: "Seed",
      brief: "b",
      slug: "seed",
      requirements: [
        { text: "First must", priority: "must", acceptance: "a" },
        { text: "Second should", priority: "should" },
      ],
    })
    const st = await readState(dir, "seed")
    expect(st.requirements.items.map((r: any) => r.id)).toEqual(["R-001", "R-002"])
    expect(st.requirements.items[1].priority).toBe("should")
    expect(st.requirements.items[0].acceptance).toBe("a")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a deleted run is not returned as the session's current run", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Gone", brief: "b", slug: "gone", mode: "fast" })
    await fs.rm(path.join(dir, "docs", "design", "gone"), { recursive: true, force: true })
    const list = JSON.parse(await call("design_list", {}))
    expect(list.current).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("an untraced must subsystem requirement blocks the root", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await soloRoot(call, j, dir)
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) })
    await call("design_add_requirement", { slug: "solo--svc", text: "extra must", priority: "must" })
    // The root guard reacts to the subsystem's ledger at once.
    expect((await readState(dir, "solo")).traceability_blocked).toBe(true)
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) }) // re-ingest keeps it
    expect((await readState(dir, "solo")).traceability_blocked).toBe(true)
    expect(j(await call("design_status", { slug: "solo" })).traceability_blocked).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a decompose root holds for decomposition even when clean only at the round budget", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "Hold", brief: "b", slug: "hold", mode: "fast", decompose: true }) // max_rounds 3
    await call("design_add_requirement", { slug: "hold", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "hold" })
    await call("design_respond", { slug: "hold", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    // rounds 1-2 leave unresolved findings (board not clean); round 3 is clean
    await call("design_begin_round", { slug: "hold" })
    await call("design_submit_verdict", { slug: "hold", verdict_json: findingsVerdict(1, ["F-1a", "F-1b"]) })
    await call("design_respond", { slug: "hold", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_begin_round", { slug: "hold" })
    await call("design_submit_verdict", { slug: "hold", verdict_json: findingsVerdict(2, ["F-2a"]) })
    await call("design_respond", { slug: "hold", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })
    await call("design_begin_round", { slug: "hold" })
    await call("design_submit_verdict", { slug: "hold", verdict_json: cleanVerdict(3, fullCov) })
    await call("design_respond", { slug: "hold", response_json: JSON.stringify({ round: 3, design_revision: "v4", responses: [] }) })
    expect((await readState(dir, "hold")).phase).toBe("awaiting_decomposition")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a configured max_parallel survives a manifest that omits it; children inherit the root tier", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "Par", brief: "b", slug: "par", preset: "deep", decompose: true, max_parallel: 3 })
    await call("design_add_requirement", { slug: "par", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "par" })
    await call("design_respond", { slug: "par", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "par" })
    await call("design_submit_verdict", { slug: "par", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "par", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const manifest = {
      system_slug: "par",
      version: 1,
      subsystems: [{ name: "svc", namespace: "SVC", title: "Svc", required: true, depends_on: [], domains: [], requirements: [{ id: "SVC-R-001", text: "r", priority: "must", system_reqs: ["R-001"] }], provides: [], requires: [] }],
      interfaces: [],
      traceability: [{ system_req: "R-001", subsystems: ["svc"], subsystem_reqs: ["SVC-R-001"] }],
    }
    await call("design_decompose", { slug: "par", decomposition_json: JSON.stringify(manifest) })
    expect((await readState(dir, "par")).max_parallel).toBe(3)
    expect((await readState(dir, "par--svc")).budgets.max_rounds).toBe(15) // deep inherited
    expect((await readState(dir, "par")).preset).toBe("deep")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("pausing a root pauses its subsystems; resume unpauses and re-pumps", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "Pause", brief: "b", slug: "pause", mode: "fast", decompose: true })
    await call("design_add_requirement", { slug: "pause", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "pause" })
    await call("design_respond", { slug: "pause", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "pause" })
    await call("design_submit_verdict", { slug: "pause", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "pause", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const reqs = (ns: string) => [{ id: `${ns}-R-001`, text: "r", priority: "must", system_reqs: ["R-001"] }]
    const manifest = {
      system_slug: "pause",
      version: 1,
      subsystems: [
        { name: "a", namespace: "A", title: "A", required: true, depends_on: [], domains: [], requirements: reqs("A"), provides: [], requires: [] },
        { name: "b", namespace: "B", title: "B", required: true, depends_on: [], domains: [], requirements: reqs("B"), provides: [], requires: [] },
      ],
      interfaces: [],
      traceability: [{ system_req: "R-001", subsystems: ["a", "b"], subsystem_reqs: ["A-R-001", "B-R-001"] }],
    }
    await call("design_decompose", { slug: "pause", decomposition_json: JSON.stringify(manifest) })
    await call("design_pause", { slug: "pause" })
    expect((await readState(dir, "pause")).paused).toBe(true)
    expect((await readState(dir, "pause--a")).paused).toBe(true)
    expect((await readState(dir, "pause--b")).paused).toBe(true)
    await call("design_resume", { slug: "pause" })
    expect((await readState(dir, "pause")).paused).toBe(false)
    expect((await readState(dir, "pause--a")).paused).toBe(false)
    expect((await readState(dir, "pause--b")).paused).toBe(false)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("invalid domains are dropped and design_config can switch the mode", async () => {
  const { dir, hooks, call } = await harness()
  try {
    const start = JSON.parse(await call("design_start", { system: "Dom", brief: "b", slug: "dom", domains: ["security", "bogus", "failure"] }))
    expect(start.config.domains).toEqual(["security", "failure"])
    const cfg = JSON.parse(await call("design_config", { slug: "dom", mode: "deep" }))
    expect(cfg.updated).toBe(true)
    expect(cfg.config.budgets.max_rounds).toBe(15)
    expect(cfg.config.preset).toBe("deep")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_start rejects an empty brief and design_add_requirement rejects a duplicate id", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    expect(j(await call("design_start", { system: "Bad", brief: "   ", slug: "bad" })).ok).toBe(false)
    await call("design_start", { system: "Dup", brief: "b", slug: "dup", mode: "fast" })
    await call("design_add_requirement", { slug: "dup", id: "R-001", text: "first", priority: "must" })
    const again = j(await call("design_add_requirement", { slug: "dup", id: "R-001", text: "second", priority: "must" }))
    expect(again.ok).toBe(false)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("spec-budget escalation is withdrawn when the design shrinks", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Spec", brief: "b", slug: "spec", mode: "fast" }) // 400-line budget
    await call("design_add_requirement", { slug: "spec", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "spec" })
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n")
    await fs.writeFile(path.join(dir, "docs", "design", "spec", "03-architecture.md"), big)
    await call("design_respond", { slug: "spec", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    expect((await readState(dir, "spec")).escalation?.requirement_id).toBe("spec-budget")
    await call("design_begin_round", { slug: "spec" })
    await call("design_submit_verdict", { slug: "spec", verdict_json: cleanVerdict(1, fullCov) })
    await fs.writeFile(path.join(dir, "docs", "design", "spec", "03-architecture.md"), "small\n")
    await call("design_respond", { slug: "spec", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    expect((await readState(dir, "spec")).escalation).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const twoSubManifest = (sysSlug: string) => {
  const reqs = (ns: string) => [{ id: `${ns}-R-001`, text: "r", priority: "must", system_reqs: ["R-001"] }]
  return {
    system_slug: sysSlug,
    version: 1,
    subsystems: [
      { name: "a", namespace: "A", title: "A", required: true, depends_on: [], domains: [], requirements: reqs("A"), provides: [], requires: [] },
      { name: "b", namespace: "B", title: "B", required: true, depends_on: [], domains: [], requirements: reqs("B"), provides: [], requires: [] },
    ],
    interfaces: [],
    traceability: [{ system_req: "R-001", subsystems: ["a", "b"], subsystem_reqs: ["A-R-001", "B-R-001"] }],
  }
}

async function decomposeTwo(call: any, slug: string) {
  await call("design_start", { system: slug, brief: "b", slug, mode: "fast", decompose: true })
  await call("design_add_requirement", { slug, text: "sys", priority: "must" })
  await call("design_confirm_requirements", { slug })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
  await call("design_begin_round", { slug })
  await call("design_submit_verdict", { slug, verdict_json: cleanVerdict(1, fullCov) })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
  await call("design_decompose", { slug, decomposition_json: JSON.stringify(twoSubManifest(slug)) })
}

test("stopping a root stops its subsystems and they are not revived", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "stop")
    await call("design_stop", { slug: "stop" })
    expect((await readState(dir, "stop")).phase).toBe("stopped")
    expect((await readState(dir, "stop--a")).phase).toBe("stopped")
    expect((await readState(dir, "stop--b")).phase).toBe("stopped")
    expect((await readState(dir, "stop--a")).dispatch).toBeFalsy()
    expect((await readState(dir, "stop--b")).dispatch).toBeFalsy()
    // a later re-ingest must not revive stopped subsystems
    await call("design_decompose", { slug: "stop", decomposition_json: JSON.stringify(twoSubManifest("stop")) })
    expect((await readState(dir, "stop--a")).phase).toBe("stopped")
    expect((await readState(dir, "stop--a")).dispatch).toBeFalsy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_decompose rejects a manifest for a different system", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await decomposeTwo(call, "mism")
    const bad = twoSubManifest("other")
    const res = j(await call("design_decompose", { slug: "mism", decomposition_json: JSON.stringify(bad) }))
    expect(res.ok).toBe(false)
    expect(res.problems.some((p: string) => p.includes("system_slug"))).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a blocked root does not dispatch its remaining subsystems", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "blk")
    // child a was pumped first (cap 1); drive it to an unaccepted terminal
    await call("design_respond", { slug: "blk--a", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "blk--a" })
    await call("design_submit_verdict", { slug: "blk--a", verdict_json: findingsVerdict(1, ["FA1", "FA2"]) })
    await call("design_respond", { slug: "blk--a", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_begin_round", { slug: "blk--a" })
    await call("design_submit_verdict", { slug: "blk--a", verdict_json: findingsVerdict(2, ["FA3", "FA4"]) })
    await call("design_respond", { slug: "blk--a", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })
    expect((await readState(dir, "blk--a")).phase).toBe("no_progress")
    expect((await readState(dir, "blk")).phase).toBe("blocked")
    expect((await readState(dir, "blk--b")).dispatch).toBeFalsy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function decomposeHold(call: any, slug: string) {
  await call("design_start", { system: slug, brief: "b", slug, mode: "fast", decompose: true })
  await call("design_add_requirement", { slug, text: "sys", priority: "must" })
  await call("design_confirm_requirements", { slug })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
  await call("design_begin_round", { slug })
  await call("design_submit_verdict", { slug, verdict_json: cleanVerdict(1, fullCov) })
  await call("design_respond", { slug, response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
}

test("a terminal root refuses a decomposition re-ingest", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await decomposeTwo(call, "term2")
    await call("design_stop", { slug: "term2" })
    const res = j(await call("design_decompose", { slug: "term2", decomposition_json: JSON.stringify(twoSubManifest("term2")) }))
    expect(res.ok).toBe(false)
    expect((await readState(dir, "term2")).phase).toBe("stopped")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a manifest with an unknown subsystem domain is rejected", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await decomposeHold(call, "domx")
    const manifest = {
      system_slug: "domx",
      version: 1,
      subsystems: [{ name: "svc", namespace: "SVC", title: "Svc", required: true, depends_on: [], domains: ["bogus"], requirements: [{ id: "SVC-R-001", text: "r", priority: "must", system_reqs: ["R-001"] }], provides: [], requires: [] }],
      interfaces: [],
      traceability: [{ system_req: "R-001", subsystems: ["svc"], subsystem_reqs: ["SVC-R-001"] }],
    }
    const res = j(await call("design_decompose", { slug: "domx", decomposition_json: JSON.stringify(manifest) }))
    expect(res.ok).toBe(false)
    expect(res.problems.some((p: string) => p.includes("unknown domain"))).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_decide recomputes a child's parent block", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await soloRoot(call, j, dir)
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) })
    await call("design_begin_round", { slug: "solo" })
    const block = {
      round: 2,
      verdict: "changes_required",
      findings: [{ id: "F-9", severity: "major", category: "security", claim: "iface", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", subsystem_ref: "svc", action: "open" }],
      coverage: fullCov,
      no_new_falsifiable_claim: false,
    }
    await call("design_submit_verdict", { slug: "solo", verdict_json: JSON.stringify(block) })
    expect((await readState(dir, "solo--svc")).acceptance_blocked_by_parent).toBe("F-9")
    await call("design_decide", { slug: "solo", finding_id: "F-9", decision: "resolved", rationale: "user" })
    expect((await readState(dir, "solo--svc")).acceptance_blocked_by_parent).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a binding requirement_gap escalates to the user", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Gap", brief: "b", slug: "gap", mode: "fast" })
    await call("design_add_requirement", { slug: "gap", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "gap" })
    await call("design_respond", { slug: "gap", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "gap" })
    const v = { round: 1, verdict: "changes_required", findings: [{ id: "F-1", severity: "major", category: "requirement_gap", claim: "c", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", action: "open" }], coverage: fullCov, no_new_falsifiable_claim: false }
    await call("design_submit_verdict", { slug: "gap", verdict_json: JSON.stringify(v) })
    expect((await readState(dir, "gap")).escalation?.requirement_id).toBe("F-1")
    // resolving the finding withdraws the escalation
    await call("design_respond", { slug: "gap", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [{ finding_id: "F-1", disposition: "fix", rationale: "handled" }] }) })
    expect((await readState(dir, "gap")).escalation).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verdict submission is idempotent and validates round/severity", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "V", brief: "b", slug: "v", mode: "fast" })
    await call("design_add_requirement", { slug: "v", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "v" })
    await call("design_respond", { slug: "v", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "v" })
    await call("design_submit_verdict", { slug: "v", verdict_json: cleanVerdict(1, fullCov) })
    expect(j(await call("design_submit_verdict", { slug: "v", verdict_json: cleanVerdict(1, fullCov) })).already).toBe(true)
    await call("design_respond", { slug: "v", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_begin_round", { slug: "v" })
    expect(j(await call("design_submit_verdict", { slug: "v", verdict_json: cleanVerdict(1, fullCov) })).ok).toBe(false) // round mismatch
    const bad = { round: 2, verdict: "changes_required", findings: [{ id: "F-1", severity: "critical", category: "data", claim: "c", counterexample: "x", evidence: { class: "executable", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x" }], coverage: fullCov, no_new_falsifiable_claim: false }
    expect(j(await call("design_submit_verdict", { slug: "v", verdict_json: JSON.stringify(bad) })).ok).toBe(false) // bad severity
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("pausing a decomposed run clears every dispatch and aborts the running child", async () => {
  const { dir, client, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "pz")
    const before = client.aborts.length
    await call("design_pause", { slug: "pz" })
    expect(client.aborts.length).toBeGreaterThan(before)
    expect((await readState(dir, "pz")).dispatch).toBeFalsy()
    expect((await readState(dir, "pz--a")).dispatch).toBeFalsy()
    expect((await readState(dir, "pz--a")).paused).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("resuming a pre-decomposition root re-dispatches it", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Rr", brief: "b", slug: "rr", mode: "fast", decompose: true })
    await call("design_add_requirement", { slug: "rr", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "rr" })
    await call("design_dispatch", { slug: "rr" })
    expect((await readState(dir, "rr")).dispatch).toBeTruthy()
    await call("design_pause", { slug: "rr" })
    expect((await readState(dir, "rr")).dispatch).toBeFalsy()
    await call("design_resume", { slug: "rr" })
    const st = await readState(dir, "rr")
    expect(st.phase).toBe("designing")
    expect(st.dispatch).toBeTruthy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("resuming a blocked root reopens its failed subsystem", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "blk2")
    await call("design_respond", { slug: "blk2--a", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "blk2--a" })
    await call("design_submit_verdict", { slug: "blk2--a", verdict_json: findingsVerdict(1, ["FA1", "FA2"]) })
    await call("design_respond", { slug: "blk2--a", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_begin_round", { slug: "blk2--a" })
    await call("design_submit_verdict", { slug: "blk2--a", verdict_json: findingsVerdict(2, ["FA3", "FA4"]) })
    await call("design_respond", { slug: "blk2--a", response_json: JSON.stringify({ round: 2, design_revision: "v3", responses: [] }) })
    expect((await readState(dir, "blk2")).phase).toBe("blocked")
    await call("design_resume", { slug: "blk2" })
    expect((await readState(dir, "blk2--a")).phase).not.toBe("no_progress")
    expect((await readState(dir, "blk2--a")).dispatch).toBeTruthy()
    expect((await readState(dir, "blk2")).phase).not.toBe("blocked")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a decompose root without a manifest wakes the Referee", async () => {
  const { dir, client, ctx, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Nm", brief: "b", slug: "nm", mode: "fast", decompose: true }) // confirm mode, no manifest written
    await call("design_add_requirement", { slug: "nm", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "nm" })
    await call("design_respond", { slug: "nm", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "nm" })
    await call("design_submit_verdict", { slug: "nm", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "nm", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const held = await readState(dir, "nm")
    expect(held.phase).toBe("awaiting_decomposition")
    // The Referee runs under the built-in build agent so it has the question tool.
    const ref = (client.prompts as any[]).find((p) => p?.path?.id === ctx.sessionID && p?.body?.agent === "build")
    expect(ref).toBeTruthy()
    expect(JSON.stringify(ref.body.parts)).toContain("question")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("decomposition auto-ingests the Architect's manifest at the hold", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Auto1", brief: "b", slug: "auto1", mode: "fast", decompose: true, decomposition: "auto" })
    await call("design_add_requirement", { slug: "auto1", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "auto1" })
    await call("design_respond", { slug: "auto1", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await fs.writeFile(path.join(dir, "docs", "design", "auto1", "decomposition.json"), JSON.stringify(twoSubManifest("auto1")))
    await call("design_begin_round", { slug: "auto1" })
    await call("design_submit_verdict", { slug: "auto1", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "auto1", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const st = await readState(dir, "auto1")
    expect(st.subsystems.length).toBe(2)
    expect(st.phase).not.toBe("awaiting_decomposition")
    expect((await readState(dir, "auto1--a")).phase).toBe("designing")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a user adjudication survives a later architect response", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "Adj", brief: "b", slug: "adj", mode: "fast" })
    await call("design_add_requirement", { slug: "adj", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "adj" })
    await call("design_respond", { slug: "adj", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "adj" })
    await call("design_submit_verdict", { slug: "adj", verdict_json: findingsVerdict(1, ["F-001"]) })
    await call("design_decide", { slug: "adj", finding_id: "F-001", decision: "resolved", rationale: "user" })
    expect((await readState(dir, "adj")).open_findings[0].status).toBe("resolved")
    // The Architect responds with no disposition for F-001; the decision must stick.
    await call("design_respond", { slug: "adj", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const f = (await readState(dir, "adj")).open_findings.find((x: any) => x.id === "F-001")
    expect(f.status).toBe("resolved")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_escalations lists and design_decide resolves across the effort", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await decomposeTwo(call, "esc2")
    await call("design_respond", { slug: "esc2--a", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "esc2--a" })
    const v = { round: 1, verdict: "changes_required", findings: [{ id: "FA", severity: "major", category: "requirement_gap", claim: "c", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", action: "open" }], coverage: fullCov, no_new_falsifiable_claim: false }
    await call("design_submit_verdict", { slug: "esc2--a", verdict_json: JSON.stringify(v) })
    const esc = j(await call("design_escalations", {}))
    expect(esc.count).toBeGreaterThanOrEqual(1)
    expect(esc.escalations.some((e: any) => e.slug === "esc2--a" && e.finding?.id === "FA")).toBe(true)
    const dec = j(await call("design_decide", { finding_id: "FA", decision: "resolved" }))
    expect(dec.ok).toBe(true)
    expect(dec.slug).toBe("esc2--a")
    expect((await readState(dir, "esc2--a")).escalation).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("decomposition confirm mode holds ready and ingests from the file on approval", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "Conf1", brief: "b", slug: "conf1", mode: "fast", decompose: true }) // default confirm
    await call("design_add_requirement", { slug: "conf1", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "conf1" })
    await call("design_respond", { slug: "conf1", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await fs.writeFile(path.join(dir, "docs", "design", "conf1", "decomposition.json"), JSON.stringify(twoSubManifest("conf1")))
    await call("design_begin_round", { slug: "conf1" })
    await call("design_submit_verdict", { slug: "conf1", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "conf1", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    const held = await readState(dir, "conf1")
    expect(held.phase).toBe("awaiting_decomposition")
    expect(held.decomposition_ready).toBe(true)
    expect(held.subsystems.length).toBe(0)
    // approval: ingest the written file (no decomposition_json)
    const dep = j(await call("design_decompose", { slug: "conf1" }))
    expect(dep.ok).toBe(true)
    expect(dep.subsystems.length).toBe(2)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("watchdog measures inactivity, not total turn duration", async () => {
  // A deliberately tiny window so the test runs in ~1s.
  const { dir, client, hooks, call, j } = await harness({ watchdogMs: 120, watchdogSweepMs: 25 })
  try {
    await call("design_start", { system: "Watch", brief: "b", slug: "watch", mode: "fast" })
    await call("design_add_requirement", { slug: "watch", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "watch" })
    const d = j(await call("design_dispatch", { slug: "watch" }))
    expect(d.dispatch.role).toBe("architect")
    let st = await readState(dir, "watch")
    const child = st.dispatch.child_session_id

    // Keep the turn alive past the window with streamed activity.
    const touch = () =>
      hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID: child } } } })
    for (let i = 0; i < 12; i++) {
      await touch()
      await sleep(25)
    }
    st = await readState(dir, "watch")
    expect(st.dispatch).not.toBe(null)
    expect(st.dispatch.retries).toBe(0)
    expect(client.prompts.length).toBe(1)
    expect(client.aborts.length).toBe(0)

    // Go silent: the sweeper retries once, aborting the silent session first.
    await sleep(500)
    expect(client.aborts.length).toBe(1)
    expect(client.prompts.length).toBe(2)
    st = await readState(dir, "watch")
    if (st.dispatch) expect(st.dispatch.retries).toBe(1)

    // Stay silent: the retry also goes quiet, so the run stops with the reason.
    await sleep(500)
    st = await readState(dir, "watch")
    expect(st.phase).toBe("no_progress")
    expect(st.stop_reason).toBe("watchdog_timeout")
    expect(st.dispatch).toBe(null)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("watchdog_ms run option overrides the plugin default", async () => {
  const { dir, hooks, call, j } = await harness({ watchdogMs: 120, watchdogSweepMs: 25 })
  try {
    await call("design_start", { system: "Watch2", brief: "b", slug: "watch2", mode: "fast" })
    const cfg = j(await call("design_config", { slug: "watch2", watchdog_ms: 60000 }))
    expect(cfg.config.watchdog_ms).toBe(60000)
    const st = await readState(dir, "watch2")
    expect(st.watchdog_ms).toBe(60000)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_decide targets an explicit subsystem slug when a finding id collides", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await decomposeTwo(call, "collide")
    const openFinding = {
      id: "F-001", severity: "major", category: "security", claim: "c", counterexample: "x",
      requirement_ids: ["A-R-001"], artifact_ref: "03-architecture.md#x",
      evidence_class: "authoritative", verification: "verified", status: "open", action: "open",
    }
    for (const sub of ["collide--a", "collide--b"]) {
      const st = await readState(dir, sub)
      st.open_findings = [{ ...openFinding }]
      await writeState(dir, sub, st)
    }
    // Ambiguous without a slug.
    const ambiguous = j(await call("design_decide", { finding_id: "F-001", decision: "resolved" }))
    expect(ambiguous.ok).toBe(false)
    expect(String(ambiguous.error)).toContain("explicit slug")
    // The exact subsystem slug (which contains `--`) selects only that run.
    const res = j(await call("design_decide", { slug: "collide--a", finding_id: "F-001", decision: "resolved" }))
    expect(res.ok).toBe(true)
    expect(res.slug).toBe("collide--a")
    expect((await readState(dir, "collide--a")).open_findings[0].status).toBe("resolved")
    expect((await readState(dir, "collide--b")).open_findings[0].status).toBe("open")
    expect((await readState(dir, "collide--a")).adjudications["F-001"]).toEqual({ decision: "resolved", round: 0 })
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Regression tests.

async function readyRun(call: any, slug: string, extra: any = {}) {
  await call("design_start", { system: slug, brief: "b", slug, mode: "fast", ...extra })
  await call("design_add_requirement", { slug, text: "r", priority: "must" })
  await call("design_confirm_requirements", { slug })
}

const promptText = (p: any) => String(p?.body?.parts?.[0]?.text || "")

test("an SDK-reported promptAsync failure drops the dead session and re-dispatches", async () => {
  let failed = false
  const { dir, client, hooks, call } = await harness({}, { promptError: () => (failed ? null : ((failed = true), { name: "NotFoundError", data: { message: "Session not found" } })) })
  try {
    await readyRun(call, "dead")
    await call("design_dispatch", { slug: "dead" })
    const st = await readState(dir, "dead")
    expect(client.prompts.length).toBe(2)
    expect(st.dispatch.child_session_id).toBe("ses_2") // a fresh session, not the dead one
    expect(st.sessions.architect).toBe("ses_2")
    expect(st.managed_sessions).not.toContain("ses_1")
    expect(client.aborts.some((a: any) => a.path.id === "ses_1")).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a subsystem that stalls out blocks its root, and the retry prompt nudges the agent", async () => {
  const { dir, client, hooks, call, emit } = await harness()
  try {
    await decomposeTwo(call, "stall")
    const child = (await readState(dir, "stall--a")).dispatch.child_session_id
    for (let i = 0; i < 2; i++) {
      await emit({ type: "session.status", properties: { sessionID: child, status: { type: "busy" } } })
      await emit({ type: "session.idle", properties: { sessionID: child } })
      if (i === 0) {
        // Re-dispatched after a turn that ended without design_respond.
        const last = client.prompts[client.prompts.length - 1]
        expect(last.path.id).toBe(child)
        expect(promptText(last)).toContain("ended without calling design_respond")
      }
    }
    const a = await readState(dir, "stall--a")
    expect(a.phase).toBe("no_progress")
    expect(a.stop_reason).toBe("dispatch_stalled")
    // The root learns of it (it used to wait forever on a stale "designing").
    expect((await readState(dir, "stall")).phase).toBe("blocked")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("an integration rejection is reworked, the subsystem re-accepts, and the root re-verifies", async () => {
  const { dir, hooks, call, emit, j } = await harness()
  try {
    await soloRoot(call, j, dir)
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) })
    await convergeChild(call, "solo--svc", { dimensions: ["security"], examined: ["security"], gaps: [] })
    let root = await readState(dir, "solo")
    expect(root.phase).toBe("falsifying")
    const rootTurn = root.dispatch.child_session_id
    const rej = {
      round: root.round,
      verdict: "changes_required",
      findings: [{ id: "F-9", severity: "major", category: "security", claim: "iface mismatch", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x", subsystem_ref: "SVC", action: "open" }],
      coverage: fullCov,
      no_new_falsifiable_claim: false,
    }
    await call("design_submit_verdict", { slug: "solo", verdict_json: JSON.stringify(rej) })
    await call("design_respond", { slug: "solo", response_json: JSON.stringify({ round: root.round, design_revision: "v4", responses: [] }) })
    // The root's turn ends; it waits for the reworking subsystem.
    await emit({ type: "session.idle", properties: { sessionID: rootTurn } })
    root = await readState(dir, "solo")
    expect(root.dispatch).toBe(null)
    expect(root.waiting_on).toEqual(["solo--svc"])
    let svc = await readState(dir, "solo--svc")
    expect(svc.phase).toBe("falsifying")
    // The subsystem sees what the parent rejected (matched by namespace).
    const ctx = j(await call("design_get_context", { slug: "solo--svc", role: "architect" }))
    expect(ctx.parent_block_findings[0].claim).toBe("iface mismatch")
    // One rework round later it can accept (it used to be blocked forever).
    const childCov = { dimensions: ["security"], examined: ["security"], gaps: [] }
    await call("design_submit_verdict", { slug: "solo--svc", verdict_json: cleanVerdict(svc.round, childCov) })
    await call("design_respond", { slug: "solo--svc", response_json: JSON.stringify({ round: svc.round, design_revision: "v4", responses: [] }) })
    svc = await readState(dir, "solo--svc")
    expect(svc.phase).toBe("converged")
    // ...and the root re-runs integration to re-verify.
    root = await readState(dir, "solo")
    expect(root.phase).toBe("falsifying")
    expect(root.round).toBe(3)
    expect(root.dispatch).toBeTruthy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("optional subsystems are designed too, after required ones", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeHold(call, "opt")
    const reqs = (ns: string) => [{ id: `${ns}-R-001`, text: "r", priority: "must", system_reqs: ["R-001"] }]
    const manifest = {
      system_slug: "opt",
      version: 1,
      subsystems: [
        { name: "extra", namespace: "EX", required: false, requirements: reqs("EX") },
        { name: "core", namespace: "CO", required: true, requirements: reqs("CO") },
      ],
      traceability: [{ system_req: "R-001", subsystem_reqs: ["CO-R-001"] }],
    }
    await call("design_decompose", { slug: "opt", decomposition_json: JSON.stringify(manifest) })
    expect((await readState(dir, "opt--core")).dispatch).toBeTruthy() // required first (cap 1)
    expect((await readState(dir, "opt--extra")).dispatch).toBeFalsy()
    await convergeChild(call, "opt--core", fullCov)
    expect((await readState(dir, "opt--extra")).dispatch).toBeTruthy() // then the optional one
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("the parallel cap counts subsystems already in progress", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "cap") // a started, b waiting (cap 1)
    // Swap roles: b is in progress without a dispatch, a has not started.
    const a = await readState(dir, "cap--a")
    const b = await readState(dir, "cap--b")
    Object.assign(b, { round: 1, design_revision: "v1", phase: "responding", dispatch: null })
    Object.assign(a, { round: 0, design_revision: "v0", phase: "designing", dispatch: null })
    await writeState(dir, "cap--a", a)
    await writeState(dir, "cap--b", b)
    await call("design_config", { slug: "cap", max_parallel: 1 }) // pumps
    expect((await readState(dir, "cap--b")).dispatch?.role).toBe("architect") // re-driven
    expect((await readState(dir, "cap--a")).dispatch).toBeFalsy() // b holds the only slot
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("subsystems inherit the root's settings; a re-ingest neither rewinds the root nor drops subsystems", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "inh", brief: "b", slug: "inh", mode: "fast", decompose: true, architect_model: "openai/gpt-x", shell_policy: "allow", strict: true, watchdog_ms: 60000 })
    await call("design_add_requirement", { slug: "inh", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "inh" })
    await call("design_respond", { slug: "inh", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "inh" })
    await call("design_submit_verdict", { slug: "inh", verdict_json: cleanVerdict(1, fullCov) })
    await call("design_respond", { slug: "inh", response_json: JSON.stringify({ round: 1, design_revision: "v2", responses: [] }) })
    await call("design_decompose", { slug: "inh", decomposition_json: JSON.stringify(twoSubManifest("inh")) })
    const a = await readState(dir, "inh--a")
    expect(a.models.architect).toBe("openai/gpt-x")
    expect(a.shellPolicy).toBe("allow")
    expect(a.allowAccepted).toBe(false)
    expect(a.watchdog_ms).toBe(60000)
    const root = await readState(dir, "inh")
    expect(root.integration_base_round).toBe(1)
    // The root is mid-integration-round: a re-ingest must not rewind it.
    root.phase = "falsifying"
    await writeState(dir, "inh", root)
    expect(j(await call("design_decompose", { slug: "inh", decomposition_json: JSON.stringify(twoSubManifest("inh")) })).ok).toBe(true)
    expect((await readState(dir, "inh")).phase).toBe("falsifying")
    // Dropping an established subsystem would orphan its run.
    const dropped = twoSubManifest("inh")
    dropped.subsystems = dropped.subsystems.slice(0, 1)
    dropped.traceability = [{ system_req: "R-001", subsystems: ["a"], subsystem_reqs: ["A-R-001"] }]
    const res = j(await call("design_decompose", { slug: "inh", decomposition_json: JSON.stringify(dropped) }))
    expect(res.ok).toBe(false)
    expect(res.problems.some((p: string) => p.includes("dropped: b"))).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("an aborted turn's MessageAbortedError does not consume the retry; a real error does", async () => {
  const { dir, client, hooks, call, emit } = await harness()
  try {
    await readyRun(call, "abrt")
    await call("design_dispatch", { slug: "abrt" })
    const child = (await readState(dir, "abrt")).dispatch.child_session_id
    await emit({ type: "session.error", properties: { sessionID: child, error: { name: "MessageAbortedError", data: { message: "aborted" } } } })
    let st = await readState(dir, "abrt")
    expect(st.dispatch.retries).toBe(0)
    expect(client.prompts.length).toBe(1)
    await emit({ type: "session.error", properties: { sessionID: child, error: { name: "APIError", data: { message: "overloaded" } } } })
    st = await readState(dir, "abrt")
    expect(st.dispatch.retries).toBe(1)
    expect(client.prompts.length).toBe(2)
    expect(promptText(client.prompts[1])).toContain("previous attempt was interrupted")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("recovery re-drives a turn the restart killed, and never touches another worktree's runs", async () => {
  const { dir, client, hooks, call } = await harness({}, { status: () => ({}) }) // nothing is busy
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "crucible-other-"))
  try {
    await readyRun(call, "rec")
    await call("design_dispatch", { slug: "rec" })
    const before = await readState(dir, "rec")
    // A run in another worktree, registered by another process, mid-dispatch.
    const foreign = { ...before, slug: "far", effort: "far", run_id: "far-1", session_id: null }
    await fs.mkdir(path.join(other, "docs", "design", "far", ".crucible"), { recursive: true })
    await fs.writeFile(path.join(other, "docs", "design", "far", ".crucible", "state.json"), JSON.stringify(foreign))
    const regFile = path.join(dataHome, "opencode-crucible", "sessions.json")
    const reg = JSON.parse(await fs.readFile(regFile, "utf8"))
    reg["ses_far"] = { current: "far", runs: { far: { dir: other, at: new Date().toISOString() } } }
    await fs.writeFile(regFile, JSON.stringify(reg))

    await hooks.config({}) // schedules recovery for this worktree
    await sleep(2300)
    const after = await readState(dir, "rec")
    // The young dispatch was dead: re-driven at once.
    expect(after.dispatch).toBeTruthy()
    expect(after.dispatch.attempt_id).not.toBe(before.dispatch.attempt_id)
    expect(after.stall_count).toBe(1)
    expect(client.prompts.length).toBe(2)
    const far = JSON.parse(await fs.readFile(path.join(other, "docs", "design", "far", ".crucible", "state.json"), "utf8"))
    expect(far.dispatch.attempt_id).toBe(before.dispatch.attempt_id) // untouched
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(other, { recursive: true, force: true })
  }
})

test("shell policy: plugin-level ask keeps opencode prompts; guarded auto-allows; destructive is denied", async () => {
  for (const [options, expected] of [[{ shellPolicy: "ask" }, "ask"], [{}, "allow"]] as const) {
    const { dir, hooks, call } = await harness(options)
    try {
      await readyRun(call, "sh")
      await call("design_dispatch", { slug: "sh" })
      const child = (await readState(dir, "sh")).dispatch.child_session_id
      const ask = async (pattern: string) => {
        const out = { status: "ask" }
        await hooks["permission.ask"]({ sessionID: child, type: "bash", pattern }, out)
        return out.status
      }
      expect(await ask("ls -la")).toBe(expected)
      expect(await ask("rm -rf /")).toBe("deny")
      expect(JSON.parse(await call("design_config", { slug: "sh" })).config.shellPolicy).toBe(expected === "ask" ? "ask" : "guarded")
    } finally {
      await hooks.dispose?.()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
})

test("dispatched agents are held to their role's tools and files", async () => {
  const { dir, hooks, call, callAs, emit, j } = await harness()
  try {
    await readyRun(call, "role")
    await call("design_dispatch", { slug: "role" })
    const architect = (await readState(dir, "role")).dispatch.child_session_id
    const asArchitect = callAs(architect)
    await expect(asArchitect("design_begin_round", { slug: "role" })).rejects.toThrow(/Referee only/)
    await expect(asArchitect("design_submit_verdict", { slug: "role", verdict_json: cleanVerdict(1, fullCov) })).rejects.toThrow(/falsifier only/)
    await expect(asArchitect("design_stop", {})).rejects.toThrow(/Referee only/)
    expect(j(await asArchitect("design_respond", { response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })).ok).toBe(true)
    await emit({ type: "session.idle", properties: { sessionID: architect } })
    const falsifier = (await readState(dir, "role")).dispatch.child_session_id
    expect(falsifier).not.toBe(architect)
    const asFalsifier = callAs(falsifier)
    await expect(asFalsifier("design_record_decision", { decision: "x" })).rejects.toThrow(/architect only/)
    await expect(asFalsifier("design_decide", { finding_id: "F-1", decision: "resolved" })).rejects.toThrow(/Referee only/)
    await expect(asFalsifier("design_start", { system: "x", brief: "b" })).rejects.toThrow(/Referee only/)

    const write = (sessionID: string, filePath: string, tool = "write") => hooks["tool.execute.before"]({ tool, sessionID, callID: "c" }, { args: { filePath, content: "x" } })
    await expect(write(falsifier, "docs/design/role/03-architecture.md")).rejects.toThrow(/Falsifier never edits/)
    await write(falsifier, "docs/design/role/07-review-log.md")
    await expect(write(architect, "docs/design/role/07-review-log.md", "edit")).rejects.toThrow(/owned by the Falsifier/)
    await expect(write(architect, "docs/design/role/.crucible/state.json")).rejects.toThrow(/\.crucible/)
    await expect(write(architect, "docs/design/other-run/03-architecture.md")).rejects.toThrow(/own run directory/)
    await write(architect, "docs/design/role/03-architecture.md")
    await expect(
      hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: falsifier, callID: "c" }, { args: { patchText: "*** Begin Patch\n*** Update File: docs/design/role/05-risks.md\n@@\n-a\n+b\n*** End Patch" } }),
    ).rejects.toThrow(/Falsifier never edits/)
    // The user's own session is never restricted.
    await hooks["tool.execute.before"]({ tool: "write", sessionID: "ses_user", callID: "c" }, { args: { filePath: "docs/design/role/.crucible/state.json" } })
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("model refs: 'inherit' clears an override; a malformed ref is rejected", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    const bad = j(await call("design_start", { system: "m", brief: "b", slug: "m", architect_model: "gpt-4" }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain("provider/model")
    await call("design_start", { system: "m", brief: "b", slug: "m", architect_model: "openai/gpt-x", falsifier_model: "inherit" })
    expect((await readState(dir, "m")).models).toEqual({ architect: "openai/gpt-x" })
    await call("design_config", { slug: "m", architect_model: "inherit" })
    expect((await readState(dir, "m")).models).toEqual({})
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design_config applies decomposition settings and re-measures coverage for new domains", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "cf", brief: "b", slug: "cf", mode: "fast" })
    const res = j(await call("design_config", { slug: "cf", decompose: true, decomposition: "auto", domains: ["security", "bogus"] }))
    expect(res.updated).toBe(true)
    expect(res.warnings[0]).toContain("bogus")
    const st = await readState(dir, "cf")
    expect(st.decompose).toBe(true)
    expect(st.decomposition_mode).toBe("auto")
    expect(st.coverage.gaps).toEqual(["security"])
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("ledger amendments stay frozen; subsystem requirements are validated", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await readyRun(call, "led")
    await call("design_add_requirement", { slug: "led", text: "late must", priority: "must" })
    const st = await readState(dir, "led")
    expect(st.requirements.version).toBe(2)
    expect(st.requirements.frozen).toBe(true)
    await soloRoot(call, j, dir)
    await call("design_decompose", { slug: "solo", decomposition_json: JSON.stringify(soloManifest) })
    expect(j(await call("design_add_requirement", { slug: "solo--svc", id: "X-R-9", text: "t", priority: "must" })).error).toContain("SVC-R-")
    expect(j(await call("design_add_requirement", { slug: "solo--svc", text: "t", priority: "must", system_reqs: ["R-404"] })).error).toContain("R-404")
    expect(j(await call("design_add_requirement", { slug: "solo--svc", text: "t", priority: "must", system_reqs: ["R-001"] })).ok).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a new session takes over the run's dialogs; lookups work from an unbound session", async () => {
  const { dir, hooks, call, callAs, j } = await harness()
  try {
    await readyRun(call, "sess")
    await call("design_respond", { slug: "sess", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "sess" })
    const gap = { round: 1, verdict: "changes_required", findings: [{ id: "G-1", severity: "major", category: "requirement_gap", claim: "c", counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x" }], coverage: fullCov, no_new_falsifiable_claim: false }
    await call("design_submit_verdict", { slug: "sess", verdict_json: JSON.stringify(gap) })
    // A brand-new session (e.g. after a restart) sees and decides it.
    const fresh = callAs("ses_new")
    const esc = j(await fresh("design_escalations", {}))
    expect(esc.escalations.some((e: any) => e.escalation.requirement_id === "G-1")).toBe(true)
    await fresh("design_dispatch", { slug: "sess" })
    expect((await readState(dir, "sess")).session_id).toBe("ses_new")
    expect(j(await fresh("design_decide", { finding_id: "G-1", decision: "accepted_risk" })).ok).toBe(true)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("resume gives a reopened run fresh counters; stopping a finished run keeps its outcome", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await readyRun(call, "rs")
    const st = await readState(dir, "rs")
    Object.assign(st, { phase: "no_progress", stop_reason: "dispatch_stalled", stall_count: 2, gate_stall_streak: 2, dispatch_error_count: 1 })
    await writeState(dir, "rs", st)
    await call("design_resume", { slug: "rs" })
    const after = await readState(dir, "rs")
    expect(after.phase).toBe("designing")
    expect([after.stall_count, after.gate_stall_streak, after.dispatch_error_count]).toEqual([0, 0, 0])

    await readyRun(call, "done")
    const done = await readState(dir, "done")
    done.phase = "converged"
    await writeState(dir, "done", done)
    const res = j(await call("design_stop", { slug: "done" }))
    expect(res.already).toBe(true)
    expect((await readState(dir, "done")).phase).toBe("converged")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("stopped subsystems resume at the phase they stopped from", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await decomposeTwo(call, "sf")
    await call("design_respond", { slug: "sf--a", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "sf--a" })
    await call("design_submit_verdict", { slug: "sf--a", verdict_json: findingsVerdict(1, ["FA1"]) })
    expect((await readState(dir, "sf--a")).phase).toBe("responding")
    await call("design_stop", { slug: "sf" })
    expect((await readState(dir, "sf--a")).stopped_from).toBe("responding")
    await call("design_resume", { slug: "sf" })
    // The unanswered verdict is answered, not skipped.
    expect((await readState(dir, "sf--a")).phase).toBe("responding")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a run under a nested docs/design root is addressed by its real path", async () => {
  const { dir, client, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "nest", brief: "b", slug: "nest", mode: "fast" })
    await fs.mkdir(path.join(dir, "proj", "docs", "design"), { recursive: true })
    await fs.rename(path.join(dir, "docs", "design", "nest"), path.join(dir, "proj", "docs", "design", "nest"))
    await fs.rm(path.join(dir, "docs"), { recursive: true, force: true })
    await call("design_add_requirement", { slug: "nest", text: "r", priority: "must" })
    await call("design_confirm_requirements", { slug: "nest" })
    await call("design_dispatch", { slug: "nest" })
    expect(promptText(client.prompts[client.prompts.length - 1])).toContain("Working directory: proj/docs/design/nest")
    expect(j(await call("design_get_context", { slug: "nest" })).design_dir).toBe("proj/docs/design/nest")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("explicit slugs are normalized and cannot escape the design root", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await call("design_start", { system: "Bank", brief: "b", mode: "fast" })
    expect(j(await call("design_status", { slug: "Bank" })).slug).toBe("bank")
    await expect(call("design_status", { slug: "../../bank" })).resolves.toContain('"slug": "bank"')
    await expect(call("design_status", { slug: "../../etc" })).rejects.toThrow(/'etc'/)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("the spec budget counts markdown in subdirectories", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await readyRun(call, "sub")
    await fs.mkdir(path.join(dir, "docs", "design", "sub", "adr"), { recursive: true })
    await fs.writeFile(path.join(dir, "docs", "design", "sub", "adr", "big.md"), Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n"))
    await call("design_respond", { slug: "sub", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    const st = await readState(dir, "sub")
    expect(st.spec_lines).toBeGreaterThan(600)
    expect(st.escalation?.requirement_id).toBe("spec-budget")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a deleted child session is replaced at once", async () => {
  const { dir, hooks, call, emit } = await harness()
  try {
    await readyRun(call, "del")
    await call("design_dispatch", { slug: "del" })
    const child = (await readState(dir, "del")).dispatch.child_session_id
    await emit({ type: "session.deleted", properties: { info: { id: child } } })
    const st = await readState(dir, "del")
    expect(st.dispatch.child_session_id).not.toBe(child)
    expect(st.dispatch.retries).toBe(1)
    expect(st.managed_sessions).not.toContain(child)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("invalid responses and verdicts are rejected with the reason, not silently ignored", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await readyRun(call, "val")
    await call("design_respond", { slug: "val", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "val" })
    const withAction = JSON.parse(findingsVerdict(1, ["F-1"]))
    withAction.findings[0].action = "accepted_risk"
    expect(j(await call("design_submit_verdict", { slug: "val", verdict_json: JSON.stringify(withAction) })).error).toContain("invalid action")
    await call("design_submit_verdict", { slug: "val", verdict_json: findingsVerdict(1, ["F-1"]) })
    const bad = j(await call("design_respond", { slug: "val", response_json: JSON.stringify({ round: 1, responses: [{ finding_id: "F-1", disposition: "fixed" }] }) }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain("invalid disposition")
    const ghost = j(await call("design_respond", { slug: "val", response_json: JSON.stringify({ round: 1, responses: [{ finding_id: "F-9", disposition: "fix" }] }) }))
    expect(ghost.error).toContain("'F-9'")
    const st = await readState(dir, "val")
    expect(st.phase).toBe("responding")
    expect(st.design_revision).toBe("v1")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a weak rebuttal keeps gating and is put to the user; reopen re-runs the ladder", async () => {
  const { dir, client, hooks, call, ctx, j } = await harness()
  try {
    await readyRun(call, "weak", { mode: "standard" })
    await call("design_respond", { slug: "weak", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "weak" })
    const v = JSON.parse(findingsVerdict(1, ["F-1", "F-2"]))
    v.findings[1].artifact_ref = "" // noise
    await call("design_submit_verdict", { slug: "weak", verdict_json: JSON.stringify(v) })
    // Classified at submission: the gate is visible during responding.
    expect(j(await call("design_status", { slug: "weak" })).open_findings.find((f: any) => f.id === "F-1").status).toBe("binding")
    await call("design_respond", {
      slug: "weak",
      response_json: JSON.stringify({ round: 1, responses: [{ finding_id: "F-1", disposition: "rebut", refutation_evidence: { class: "belief", detail: "no" } }] }),
    })
    const st = await readState(dir, "weak")
    const f1 = st.open_findings.find((f: any) => f.id === "F-1")
    expect(f1.contested).toBe(true)
    expect(st.history[0].gate).toBe(1)
    expect(st.escalations.some((e: any) => e.requirement_id === "F-1")).toBe(true)
    expect(client.prompts.some((p: any) => p.path.id === ctx.sessionID && promptText(p).includes("F-1"))).toBe(true)
    // Reopening a noise finding re-runs the ladder (it stays noise).
    await call("design_decide", { slug: "weak", finding_id: "F-2", decision: "resolved" })
    const reopened = j(await call("design_decide", { slug: "weak", finding_id: "F-2", decision: "reopen" }))
    expect(reopened.finding.status).toBe("rejected_noise")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("deciding on a finished run rewrites its open-issues report; notices can be acknowledged", async () => {
  const { dir, hooks, call, j } = await harness()
  try {
    await readyRun(call, "fin")
    await fs.writeFile(path.join(dir, "docs", "design", "fin", "03-architecture.md"), Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n"))
    await call("design_respond", { slug: "fin", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    const ack = j(await call("design_decide", { finding_id: "spec-budget", decision: "accepted_risk" }))
    expect(ack.acknowledged).toBe(true)
    expect(j(await call("design_escalations", {})).count).toBe(0)
    const st = await readState(dir, "fin")
    Object.assign(st, { phase: "budget_stopped", open_findings: [{ id: "F-1", severity: "major", category: "data", status: "binding", claim: "loses writes", round: 1 }] })
    await writeState(dir, "fin", st)
    await call("design_decide", { slug: "fin", finding_id: "F-1", decision: "accepted_risk" })
    const report = await fs.readFile(path.join(dir, "docs", "design", "fin", "08-open-issues.md"), "utf8")
    expect(report).toContain("| F-1 | major | data | user | loses writes |")
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a live turn's activity is persisted for the TUI", async () => {
  const { dir, hooks, call, emit } = await harness({ heartbeatMs: 10 })
  try {
    await readyRun(call, "hb")
    await call("design_dispatch", { slug: "hb" })
    const child = (await readState(dir, "hb")).dispatch.child_session_id
    await sleep(20)
    await emit({ type: "message.part.updated", properties: { part: { sessionID: child } } })
    await sleep(50)
    expect((await readState(dir, "hb")).dispatch.last_activity_at).toBeTruthy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("auto-ingest at the round budget starts integration instead of stopping the root", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await call("design_start", { system: "ab", brief: "b", slug: "ab", mode: "fast", decompose: true, decomposition: "auto" }) // max_rounds 3
    await call("design_add_requirement", { slug: "ab", text: "sys", priority: "must" })
    await call("design_confirm_requirements", { slug: "ab" })
    await call("design_respond", { slug: "ab", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await fs.writeFile(path.join(dir, "docs", "design", "ab", "decomposition.json"), JSON.stringify(twoSubManifest("ab")))
    // Rounds 1-2 leave findings open; round 3 is clean, exactly at the budget.
    for (const [round, ids] of [[1, ["F-1a", "F-1b"]], [2, ["F-2a"]]] as const) {
      await call("design_begin_round", { slug: "ab" })
      await call("design_submit_verdict", { slug: "ab", verdict_json: findingsVerdict(round, [...ids]) })
      await call("design_respond", { slug: "ab", response_json: JSON.stringify({ round, design_revision: `v${round + 1}`, responses: [] }) })
    }
    await call("design_begin_round", { slug: "ab" })
    await call("design_submit_verdict", { slug: "ab", verdict_json: cleanVerdict(3, fullCov) })
    await call("design_respond", { slug: "ab", response_json: JSON.stringify({ round: 3, design_revision: "v4", responses: [] }) })
    const root = await readState(dir, "ab")
    expect(root.subsystems.length).toBe(2)
    expect(root.phase).toBe("designing") // not budget_stopped
    expect(root.integration_base_round).toBe(3)
    expect((await readState(dir, "ab--a")).dispatch).toBeTruthy()
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a new verdict withdraws the previous round's finding escalations", async () => {
  const { dir, hooks, call } = await harness()
  try {
    await readyRun(call, "esr", { mode: "standard" })
    await call("design_respond", { slug: "esr", response_json: JSON.stringify({ round: 0, design_revision: "v1", responses: [] }) })
    await call("design_begin_round", { slug: "esr" })
    const gap = (round: number) => JSON.stringify({ round, verdict: "changes_required", findings: [{ id: "F-1", severity: "major", category: round === 1 ? "requirement_gap" : "data", claim: `c${round}`, counterexample: "x", evidence: { class: "authoritative", verification: "verified" }, requirement_ids: ["R-001"], artifact_ref: "03-architecture.md#x" }], coverage: fullCov, no_new_falsifiable_claim: false })
    await call("design_submit_verdict", { slug: "esr", verdict_json: gap(1) })
    await call("design_respond", { slug: "esr", response_json: JSON.stringify({ round: 1, responses: [] }) })
    expect((await readState(dir, "esr")).escalations.some((e: any) => e.requirement_id === "F-1")).toBe(true)
    await call("design_begin_round", { slug: "esr" })
    // Round 2's F-1 is an unrelated data finding: the round-1 gap escalation is gone.
    await call("design_submit_verdict", { slug: "esr", verdict_json: gap(2) })
    expect((await readState(dir, "esr")).escalations.some((e: any) => e.requirement_id === "F-1")).toBe(false)
  } finally {
    await hooks.dispose?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
