import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTaskContinuation } from "../src/task-continuation.js";
import { TaskStore } from "../src/task-store.js";

const runId = "6289edd8-24e4-4500-9a08-f72e7af1c2df";
const sessionFile = "/sessions/caller.jsonl";
function setup() {
  vi.useFakeTimers();
  const store = new TaskStore();
  store.create("Reconcile review", "Read the subscribed review and resolve its findings");
  store.update("1", { status: "in_progress", owner: "lead" });
  const events = new EventEmitter();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const controller = new AbortController();
  let activeSignal: AbortSignal | undefined;
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: vi.fn(() => false),
    get signal() {
      return activeSignal;
    },
    sessionManager: { getSessionId: () => "caller", getSessionFile: () => sessionFile },
  };
  const pi = {
    events,
    sendMessage: vi.fn(),
    getAllTools: () => [],
    on: (name: string, fn: (event: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  registerTaskContinuation(pi as any, () => store);
  const state: Record<string, unknown> = {
    version: 1,
    runId,
    sessionFile,
    status: "waiting",
    deadline: Date.now() + 60_000,
  };
  const subscribe = () =>
    events.on("agentic-code-review:wait-probe", (request) => {
      if (request.sessionFile === sessionFile && request.runId === runId) request.reply(state);
    });
  const fire = async (name: string, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  const start = async () => {
    activeSignal = controller.signal;
    await fire("agent_start");
    await fire("turn_start");
  };
  const finish = async () => {
    await fire("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
    activeSignal = undefined;
    await fire("agent_settled");
  };
  const wait = (patch = {}) =>
    tools.get("task_wait").execute(
      "wait",
      {
        taskId: "1",
        reviewRunId: runId,
        reason: "The subscribed review owns progress",
        expectedSignal: "Read its saved completion report",
        ...patch,
      },
      controller.signal,
      undefined,
      ctx,
    );
  const continuations = () =>
    pi.sendMessage.mock.calls.filter(([message]) => message.customType === "tasks-continuation");
  return { pi, ctx, store, state, events, subscribe, fire, start, finish, wait, continuations, controller };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("registered external review waits", () => {
  it("waits without a scheduler and resumes for a review handoff without task mutations", async () => {
    const m = setup();
    m.subscribe();
    const before = JSON.stringify(m.store.list());
    await m.start();
    expect(await m.wait()).toMatchObject({ terminate: true, details: { taskId: "1", reviewRunId: runId } });
    await m.finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.continuations()).toHaveLength(0);
    expect(JSON.stringify(m.store.list())).toBe(before);
    await m.start();
    m.store.update("1", { status: "completed" });
    await m.finish();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "missing",
    "foreign caller",
    "wrong run",
    "ended",
    "delivered",
    "expired",
    "unbounded",
    "duplicate",
    "two sources",
  ])("rejects %s handoff evidence", async (reason) => {
    const m = setup();
    if (reason !== "missing") m.subscribe();
    if (reason === "foreign caller") m.state.sessionFile = "/sessions/other.jsonl";
    if (reason === "wrong run") m.state.runId = "another";
    if (["ended", "delivered"].includes(reason)) m.state.status = reason;
    if (reason === "expired") m.state.deadline = Date.now();
    if (reason === "unbounded") m.state.deadline = Date.now() + 3_600_001;
    if (reason === "duplicate") m.subscribe();
    await m.start();
    await expect(m.wait(reason === "two sources" ? { schedulerTaskId: "existing" } : {})).rejects.toThrow();
    await m.finish();
    expect(m.continuations()).toHaveLength(1);
  });

  it.each([
    "deadline",
    "ended",
    "extension",
    "queue",
    "provider lost",
  ])("reassesses %s once without marking the task done", async (reason) => {
    const m = setup();
    m.subscribe();
    await m.start();
    await m.wait();
    await m.finish();
    if (reason === "ended") m.state.status = "ended";
    if (reason === "extension") m.state.deadline = Number(m.state.deadline) + 1000;
    if (reason === "queue") m.store.create("Independent", "Can proceed");
    if (reason === "provider lost") m.events.removeAllListeners("agentic-code-review:wait-probe");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.continuations()).toHaveLength(1);
    expect(m.store.get("1")?.status).toBe("in_progress");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects independent work and a handoff consumed during enrollment", async () => {
    const m = setup();
    m.subscribe();
    m.store.create("Independent", "Can proceed");
    await m.start();
    await expect(m.wait()).rejects.toThrow("outside this dependency chain");
    m.store.update("2", { status: "completed" });
    let probes = 0;
    m.events.removeAllListeners("agentic-code-review:wait-probe");
    m.events.on("agentic-code-review:wait-probe", (request) =>
      request.reply({ ...m.state, status: ++probes === 1 ? "waiting" : "delivered" }),
    );
    await expect(m.wait()).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a producer wake during a health probe take over without stale recovery", async () => {
    const m = setup();
    m.subscribe();
    await m.start();
    await m.wait();
    await m.finish();
    m.events.removeAllListeners("agentic-code-review:wait-probe");
    m.events.on("agentic-code-review:wait-probe", (request) => {
      void m.start(); // A producer notification can start a run before the probe returns.
      request.reply({ ...m.state, status: "delivered" });
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "input",
    "session_shutdown",
    "session_tree",
    "abort",
  ])("clears on %s without late monitor recovery", async (action) => {
    const m = setup();
    m.subscribe();
    await m.start();
    await m.wait();
    if (action === "abort") m.controller.abort();
    else await m.fire(action);
    if (action === "abort") await m.finish();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.continuations()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
