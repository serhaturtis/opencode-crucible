import { describe, expect, test } from "bun:test"
import {
  currentEffort,
  displayName,
  effortLead,
  groupEfforts,
  inactivityWindow,
  isVisible,
  needsYou,
  partitionEfforts,
  shortName,
  sortEfforts,
  subsystemCounts,
  type Run,
} from "../src/tui-runs"

function run(slug: string, phase: string, parent: string | null = null, extra: Record<string, any> = {}, mtime = 0): Run {
  return { slug, state: { slug, phase, parent_slug: parent, ...extra }, mtime }
}

describe("crucible tui run grouping", () => {
  test("groups a decomposition under its root with the root first", () => {
    const efforts = groupEfforts([
      run("sys", "converged", null, {}, 1),
      run("sys--b", "designing", "sys", {}, 30),
      run("sys--a", "converged", "sys", {}, 20),
    ])
    expect(efforts).toHaveLength(1)
    expect(efforts[0].root).toBe("sys")
    expect(efforts[0].runs.map((r) => r.slug)).toEqual(["sys", "sys--b", "sys--a"])
    expect(efforts[0].rootRun?.slug).toBe("sys")
    expect(shortName(efforts[0], "sys--b")).toBe("b")
  })

  test("groups an orphan child under the parent slug it names", () => {
    const efforts = groupEfforts([run("root--child", "designing", "root")])
    expect(efforts[0].root).toBe("root")
    expect(efforts[0].rootRun).toBeUndefined()
  })

  test("auto-hides settled designs but shows live work, current runs, and attention", () => {
    const settled = groupEfforts([run("old", "converged")])[0]
    expect(isVisible(settled, null, {})).toBe(false)
    expect(isVisible(settled, "old", {})).toBe(true)

    const liveChild = groupEfforts([run("root", "converged"), run("root--child", "designing", "root")])[0]
    expect(isVisible(liveChild, null, {})).toBe(true)

    const attention = groupEfforts([run("paused", "designing", null, {
      escalations: [{ status: "pending_user_ratification", notified: true }],
    })])[0]
    expect(needsYou(attention.runs[0].state)).toBe(true)
    expect(isVisible(attention, null, {})).toBe(true)

    const undelivered = groupEfforts([run("undelivered", "converged", null, {
      escalations: [{ status: "pending_user_ratification", notified: false }],
    })])[0]
    expect(isVisible(undelivered, null, {})).toBe(true)
  })

  test("an escalation that was not delivered is not a needs-you run", () => {
    const undelivered = groupEfforts([run("pending", "designing", null, {
      escalations: [{ status: "pending_user_ratification", notified: false }],
    })])[0]
    expect(needsYou(undelivered.runs[0].state)).toBe(false)
  })

  test("an explicit show or hide always wins", () => {
    const settled = groupEfforts([run("old", "converged")])[0]
    expect(isVisible(settled, null, { old: "show" })).toBe(true)

    const live = groupEfforts([run("active", "designing")])[0]
    expect(isVisible(live, "active", { active: "hide" })).toBe(false)
  })

  test("sorts the current effort first, then attention, and counts the hidden rest", () => {
    const efforts = groupEfforts([
      run("old", "converged", null, {}, 100),
      run("attention", "designing", null, { escalations: [{ status: "pending_user_ratification", notified: true }] }, 50),
      run("current", "designing", null, {}, 10),
    ])
    expect(sortEfforts(efforts, "current").map((e) => e.root)).toEqual(["current", "attention", "old"])

    const { visible, hidden } = partitionEfforts(efforts, "current", { old: "hide" })
    expect(visible.map((e) => e.root)).toEqual(["current", "attention"])
    expect(hidden).toBe(1)
    expect(currentEffort(efforts, "current")?.root).toBe("current")
  })

  test("uses the dispatch's active inactivity window before the run fallback", () => {
    expect(inactivityWindow({ dispatch: { watchdog_ms: 1_800_000 } }, 600_000)).toBe(1_800_000)
    expect(inactivityWindow({ watchdog_ms: 90_000 }, 600_000)).toBe(90_000)
    expect(inactivityWindow({}, 600_000)).toBe(600_000)
    expect(inactivityWindow(undefined, 600_000)).toBe(600_000)
  })

  test("counts declared subsystems before their state files exist", () => {
    const effort = groupEfforts([
      run("root", "designing", null, { subsystems: [{ name: "a" }, { name: "b" }, { name: "c" }] }),
      run("root--a", "designing", "root"),
      run("root--b", "converged", "root"),
    ])[0]
    expect(subsystemCounts(effort)).toEqual({ total: 3, live: 1 })
  })

  test("displayName keeps narrow sidebar labels readable", () => {
    expect(displayName("engineering-compiler-sentinel-v0-1")).toBe("sentinel")
    expect(displayName("engineering-compiler-proving-ground-v0-1")).toBe("proving-ground")
    expect(displayName("engineering-compiler-v0-1")).toBe("core")
    expect(displayName("engineering-compiler-foundry-v0-1--emission")).toBe("emission")
    expect(displayName("bank")).toBe("bank")
  })

  test("effortLead prefers the attention run, then live work, then the root", () => {
    const effort = groupEfforts([
      run("root", "converged"),
      run("root--live", "designing", "root"),
      run("root--need", "converged", "root", { escalations: [{ status: "pending_user_ratification", notified: true }] }),
    ])[0]
    expect(effortLead(effort).slug).toBe("root--need")
  })

  test("an undelivered question still leads its effort and ranks above settled work", () => {
    const effort = groupEfforts([
      run("root", "converged"),
      run("root--pending", "converged", "root", { escalations: [{ status: "pending_user_ratification", notified: false }] }),
      run("root--live", "designing", "root"),
    ])[0]
    expect(effortLead(effort).slug).toBe("root--pending")
    const efforts = groupEfforts([
      run("old", "converged", null, {}, 100),
      run("pending", "converged", null, { escalations: [{ status: "pending_user_ratification", notified: false }] }, 50),
    ])
    expect(sortEfforts(efforts, null).map((e) => e.root)).toEqual(["pending", "old"])
  })
})
