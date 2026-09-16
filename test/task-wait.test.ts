import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskContinuation } from "../src/task-continuation.js";
import { TaskStore } from "../src/task-store.js";

let dir: string;
let stateFile: string;
const sessionFile = "/sessions/session-a.jsonl";
const now = Date.parse("2026-09-16T00:00:00Z");
const request = {
  taskId: "1",
  schedulerTaskId: "task-review",
  reason: "The external review is still running",
  expectedSignal: "The scheduled completion check delivers the finished review",
};
function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-review",
    action: "shell",
    type: "interval",
    schedule: "10m",
    status: "pending",
    enabled: true,
    scope: "session",
    sessionFile,
    createdAt: new Date(now).toISOString(),
    runCount: 0,
    nextRun: new Date(now + 600_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    command: "test -f review.complete.json",
    timeoutMs: 1000,
    wakeOn: "success",
    stopOn: "success",
    maxRuns: 6,
    ...overrides,
  };
}
function save(task: Record<string, unknown> = schedule()) {
  writeFileSync(stateFile, JSON.stringify({ version: 2, tasks: [task] }));
}
function setup() {
  const store = new TaskStore();
  store.create("Review", "Integrate the external review");
  store.update("1", { status: "in_progress", owner: "lead" });
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const controller = new AbortController();
  let activeSignal: AbortSignal | undefined;
  const ctx = {
    hasUI: true,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    get signal() {
      return activeSignal;
    },
    sessionManager: { getSessionId: () => "session-a", getSessionFile: () => sessionFile },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
  const pi = {
    on(name: string, fn: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    getAllTools: vi.fn(() => [{ name: "schedule_task" }, { name: "list_scheduled_tasks" }]),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
  const onWaitChanged = vi.fn();
  registerTaskContinuation(pi as any, () => store, onWaitChanged);
  const fire = async (name: string, event: any = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  const start = async () => {
    activeSignal = controller.signal;
    await fire("agent_start");
    await fire("turn_start");
  };
  const finish = async (stopReason = "stop") => {
    await fire("turn_end", { message: { role: "assistant", stopReason } });
    activeSignal = undefined;
    await fire("agent_settled");
  };
  const wait = (params: Record<string, unknown> = request) =>
    tools.get("task_wait").execute("wait-call", params, controller.signal, undefined, ctx);
  const continuations = () =>
    pi.sendMessage.mock.calls.filter(
      ([message, options]) => message.customType === "tasks-continuation" && options?.triggerTurn,
    );
  return { store, pi, ctx, controller, fire, start, finish, wait, continuations, onWaitChanged };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), "task-wait-"));
  stateFile = join(dir, "scheduler.json");
  vi.stubEnv("PI_SCHEDULER_STATE_FILE", stateFile);
  save();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("explicit scheduler-backed task_wait", () => {
  it("holds the pi-coder dependency chain without changing tasks or schedules, then lets the wake run resume", async () => {
    const m = setup();
    m.store.create("Merge", "After review");
    m.store.create("Release", "After merge");
    m.store.update("2", { addBlockedBy: ["1"] });
    m.store.update("3", { addBlockedBy: ["2"] });
    const tasksBefore = JSON.stringify(m.store.list());
    const schedulerBefore = readFileSync(stateFile, "utf8");
    await m.start();
    const result = await m.wait();
    expect(result.details).toMatchObject({ taskId: "1", schedulerTaskId: "task-review" });
    expect(m.onWaitChanged).toHaveBeenLastCalledWith("1");
    expect(m.ctx.ui.setStatus).toHaveBeenCalledWith("task-wait", expect.stringContaining("#1"));
    await m.finish();
    await m.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(590_000);
    expect(m.continuations()).toHaveLength(0);
    expect(JSON.stringify(m.store.list())).toBe(tasksBefore);
    expect(readFileSync(stateFile, "utf8")).toBe(schedulerBefore);
    await m.start(); // Scheduler delivery or early auto-review handoff owns this run.
    expect(m.onWaitChanged).toHaveBeenLastCalledWith(undefined);
    m.store.update("1", { status: "completed" });
    m.store.update("2", { status: "completed" });
    m.store.update("3", { status: "completed" });
    await m.finish();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["foreign session", { sessionFile: "/sessions/other.jsonl" }],
    ["shared project", { scope: "cwd" }],
    ["global", { scope: "global" }],
    ["notification only", { action: "notify" }],
    ["non-waking message", { action: "message", triggerTurn: false }],
    ["silent shell", { wakeOn: "never" }],
    ["change baseline", { wakeOn: "change" }],
    ["disabled", { enabled: false }],
    ["cancelled", { status: "cancelled" }],
    ["completed", { status: "fired" }],
    ["unbounded", { expiresAt: undefined }],
    ["expired", { expiresAt: new Date(now).toISOString() }],
    ["over 24 hours", { expiresAt: new Date(now + 90_000_000).toISOString() }],
    ["missing next run", { nextRun: undefined }],
    ["run after expiry", { nextRun: new Date(now + 7_200_000).toISOString() }],
    ["run exactly at expiry", { nextRun: new Date(now + 3_600_000).toISOString() }],
    ["exhausted", { runCount: 6 }],
    ["invalid count", { runCount: -1 }],
    ["unbounded shell", { timeoutMs: undefined }],
    ["already delivering", { result: { attemptId: "a", wakeDisposition: "pending" } }],
    ["already delivered", { result: { attemptId: "a", wakeDisposition: "delivered" } }],
  ])("rejects %s schedules without suppressing ordinary continuation", async (_label, patch) => {
    save(schedule(patch));
    const m = setup();
    await m.start();
    await expect(m.wait()).rejects.toThrow();
    await m.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "missing",
    "malformed",
    "unsupported",
    "duplicate id",
    "prefix",
  ])("rejects %s scheduler evidence", async (reason) => {
    if (reason === "missing") rmSync(stateFile);
    if (reason === "malformed") writeFileSync(stateFile, "{");
    if (reason === "unsupported") writeFileSync(stateFile, JSON.stringify({ version: 3, tasks: [schedule()] }));
    if (reason === "duplicate id")
      writeFileSync(stateFile, JSON.stringify({ version: 2, tasks: [schedule(), schedule()] }));
    const m = setup();
    await m.start();
    await expect(
      m.wait({ ...request, schedulerTaskId: reason === "prefix" ? "task-re" : "task-review" }),
    ).rejects.toThrow();
    await m.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
  });

  it.each([
    "pending task",
    "unowned task",
    "completed task",
    "group",
    "independent task",
    "empty group",
    "blank reason",
    "blank signal",
  ])("rejects %s", async (reason) => {
    const m = setup();
    let taskId = "1";
    if (reason === "pending task" || reason === "unowned task") {
      taskId = m.store.create("Other", "Other").id;
      if (reason === "unowned task") {
        m.store.update("1", { status: "completed" });
        m.store.update(taskId, { status: "in_progress" });
      }
    }
    if (reason === "completed task") m.store.update("1", { status: "completed" });
    if (reason === "group" || reason === "empty group") {
      const group = m.store.create("Group", "Group", undefined, undefined, undefined, { kind: "group" });
      if (reason === "group") taskId = group.id;
    }
    if (reason === "independent task") m.store.create("Independent", "Could proceed");
    await m.start();
    await expect(
      m.wait({
        ...request,
        taskId,
        reason: reason === "blank reason" ? " " : request.reason,
        expectedSignal: reason === "blank signal" ? " " : request.expectedSignal,
      }),
    ).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows derived groups whose remaining leaves depend on the waited task", async () => {
    const m = setup();
    const group = m.store.create("Group", "Group", undefined, undefined, undefined, { kind: "group" });
    const child = m.store.create("Dependent", "Desc", undefined, undefined, undefined, { parentId: group.id });
    m.store.update(child.id, { addBlockedBy: ["1"] });
    await m.start();
    await m.wait();
    await m.finish();
    expect(m.continuations()).toHaveLength(0);
  });

  it.each(["prompt", "message"])("accepts an enabled finite %s wake", async (action) => {
    save(schedule({ action, prompt: "Resume review", message: "Resume review" }));
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    expect(m.continuations()).toHaveLength(0);
  });

  it.each([
    "cancel",
    "disable",
    "remove",
    "corrupt",
    "expire",
    "exhaust",
    "delivery failure",
    "new work",
    "task edit",
    "schedule edit",
  ])("recovers once on %s without completing work", async (reason) => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    if (reason === "cancel") save(schedule({ status: "cancelled", enabled: false }));
    if (reason === "disable") save(schedule({ enabled: false }));
    if (reason === "remove") rmSync(stateFile);
    if (reason === "corrupt") writeFileSync(stateFile, "{");
    if (reason === "expire") save(schedule({ status: "expired", enabled: false }));
    if (reason === "exhaust") save(schedule({ runCount: 6, status: "failed", enabled: false }));
    if (reason === "delivery failure")
      save(schedule({ result: { attemptId: "attempt-1", wakeDisposition: "failed" } }));
    if (reason === "new work") m.store.create("New work", "Can advance");
    if (reason === "task edit") m.store.update("1", { description: "Changed acceptance" });
    if (reason === "schedule edit") save(schedule({ command: "other check" }));
    await vi.advanceTimersByTimeAsync(60_000);
    await m.fire("agent_settled");
    expect(m.continuations()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(m.store.get("1")?.status).toBe("in_progress");
    expect(vi.getTimerCount()).toBe(0);
    expect(m.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "task-wait-ended" }),
      expect.objectContaining({ triggerTurn: false }),
    );
  });

  it("tolerates quiet failed polls and live running attempts without model turns", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    save(
      schedule({
        runCount: 1,
        result: { attemptId: "a", wakeDisposition: "not-requested" },
        nextRun: new Date(now + 1_200_000).toISOString(),
      }),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    save(schedule({ status: "running", startedAt: new Date(Date.now()).toISOString(), runAttemptId: "b" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.continuations()).toHaveLength(0);
  });

  it("gives split terminal delivery a grace period and lets its arriving run clear the wait", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    save(
      schedule({
        status: "fired",
        enabled: false,
        runCount: 1,
        result: { attemptId: "a", wakeDisposition: "pending" },
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.continuations()).toHaveLength(0);
    await m.start();
    m.store.update("1", { status: "completed" });
    await m.finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.continuations()).toHaveLength(0);
  });

  it.each([
    "pending",
    "delivered",
  ])("does not strand work when delivery stays %s without an arriving run", async (wakeDisposition) => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    save(schedule({ status: "fired", enabled: false, result: { attemptId: "a", wakeDisposition } }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(m.continuations()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
  });

  it.each(["busy", "queued"])("does not add a recovery wake while %s", async (state) => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    if (state === "busy") m.ctx.isIdle.mockReturnValue(false);
    else m.ctx.hasPendingMessages.mockReturnValue(true);
    save(schedule({ enabled: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.continuations()).toHaveLength(0);
  });

  it.each([
    "session_shutdown",
    "session_start",
    "session_tree",
  ])("clears timers on %s without waking a session", async (event) => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    await m.fire(event, { reason: "reload" });
    await vi.advanceTimersByTimeAsync(7_200_000);
    await m.fire("agent_settled");
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["aborted", "error"])("never retries after %s", async (stopReason) => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish(stopReason);
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "not loaded",
    "no session file",
    "queued message",
    "aborted call",
  ])("rejects admission with %s", async (reason) => {
    const m = setup();
    await m.start();
    if (reason === "not loaded") m.pi.getAllTools.mockReturnValue([]);
    if (reason === "no session file") m.ctx.sessionManager.getSessionFile = () => undefined as any;
    if (reason === "queued message") m.ctx.hasPendingMessages.mockReturnValue(true);
    if (reason === "aborted call") m.controller.abort();
    await expect(m.wait()).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend an active wait and holds a terminating toolUse turn", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await expect(m.wait()).rejects.toThrow("already active");
    await m.finish("toolUse");
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["pending", "running"])("recovers when a %s scheduler stalls", async (status) => {
    save(schedule({ status, startedAt: new Date(now).toISOString(), runAttemptId: "a" }));
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    await vi.advanceTimersByTimeAsync(status === "running" ? 35_000 : 635_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at expiry even if the scheduler never saves expired status", async () => {
    save(schedule({ nextRun: new Date(now + 5000).toISOString(), expiresAt: new Date(now + 10_000).toISOString() }));
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
  });

  it("reconciles a cancellation between the initial snapshot and enrollment", async () => {
    const m = setup();
    m.pi.getAllTools
      .mockImplementationOnce(() => [{ name: "schedule_task" }])
      .mockImplementation(() => {
        save(schedule({ enabled: false }));
        return [{ name: "schedule_task" }];
      });
    await m.start();
    await expect(m.wait()).rejects.toThrow("changed during admission");
    await m.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a non-waking scheduler result clear a valid wait", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    await m.fire("message_start", {
      message: { role: "custom", customType: "scheduled-task", details: { task: schedule(), result: { code: 1 } } },
    });
    await m.fire("agent_settled");
    expect(m.continuations()).toHaveLength(0);
  });

  it("clears on input received in the same run", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.fire("input", { source: "interactive", text: "Stop waiting" });
    await m.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors active-run cancellation after the live signal disappears at settlement", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    m.controller.abort();
    await m.finish("toolUse");
    save(schedule({ enabled: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the wait when the user resumes, rather than automatically rearming it", async () => {
    const m = setup();
    await m.start();
    await m.wait();
    await m.finish();
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(m.continuations()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
