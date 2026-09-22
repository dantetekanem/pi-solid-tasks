import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

const NUDGE_DELAY = 5 * 60_000;
beforeEach(() => {
  process.env.PI_TASKS = "off";
  vi.useFakeTimers();
});
afterEach(() => {
  delete process.env.PI_TASKS;
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const controller = new AbortController();
  const ctx = {
    isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), signal: controller.signal,
    sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() },
    abort: vi.fn(async () => { controller.abort(); }),
  };
  const pi = {
    on(name: string, fn: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    events: { emit: vi.fn() }, sendMessage: vi.fn(), sendUserMessage: vi.fn(),
  };
  initExtension(pi as any);
  const fire = async (name: string, event: any = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  const execute = (name: string, args: any) => tools.get(name).execute("call", args, controller.signal, undefined, ctx);
  const start = async () => {
    await fire("agent_start");
    await fire("turn_start");
  };
  const finish = async (stopReason = "stop") => {
    await fire("turn_end", { message: { role: "assistant", stopReason } });
    await fire("agent_settled");
  };
  return { pi, ctx, controller, fire, execute, start, finish, commands };
}

describe("runtime task continuation", () => {
  it.each(["interactive", "rpc"])("caps nudges at two until new %s input, without changing task state", async (source) => {
    const m = setup();
    await m.execute("tasks_create_in_batch", { tasks: [
      { subject: "First", description: "First evidence" }, { subject: "Second", description: "Second evidence" },
    ] });
    await m.start();
    await m.fire("agent_end");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.finish();
    await m.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY - 1);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(m.pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      customType: "tasks-continuation", details: { taskIds: ["1", "2"] },
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect((await m.execute("task_get", { taskId: "1" })).content[0].text).toContain("Status: pending");

    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY - 1);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(2);
    await m.fire("input", { source: "extension" });
    await m.fire("message_start", { message: { role: "user" } });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY * 3);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(2);

    await m.fire("input", { source, text: "Continue" });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(3);
    expect((await m.execute("task_get", { taskId: "1" })).content[0].text).toContain("Status: pending");
  });

  it("does not wake an empty queue, but does wake an unfinished empty group", async () => {
    const m = setup();
    await m.start();
    await m.finish();
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.execute("task_create", { kind: "group", subject: "Project", description: "Needs children" });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage.mock.lastCall?.[0].details).toEqual({ taskIds: ["1"] });
  });

  it.each(["busy", "pending input", "aborted", "error", "shutdown"])("does not restart on %s", async (reason) => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    if (reason === "busy") m.ctx.isIdle.mockReturnValue(false);
    if (reason === "pending input") m.ctx.hasPendingMessages.mockReturnValue(true);
    if (reason === "shutdown") await m.fire("session_shutdown");
    await m.finish(reason === "aborted" || reason === "error" ? reason : "stop");
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("honors Escape during a tool even when the last assistant stop reason is toolUse", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    m.controller.abort();
    await m.finish("toolUse");
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not retry a run that failed before producing an assistant result", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.fire("agent_settled");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("waits for question tools and UI prompts, then wakes after they close even on cancellation", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.fire("tool_execution_start", { toolName: "ask_user", toolCallId: "q" });
    await m.fire("ui_prompt_start");
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.fire("ui_prompt_end");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.fire("tool_execution_end", { toolName: "ask_user", toolCallId: "q", result: { details: { cancelled: true } } });
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("uses only matching-session delegation evidence and resumes through the report run", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Review", description: "Agent working" });
    m.pi.events.emit.mockImplementation((_name, probe) => {
      probe.respond({ sessionId: "session-a", running: 1, queued: 0 });
    });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.events.emit).toHaveBeenCalledWith("pi-extended-teams:child-agent-lifecycle-probe", expect.objectContaining({ sessionId: "session-a" }));
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    m.pi.events.emit.mockImplementation((_name, probe) => {
      probe.respond({ sessionId: "other-session", running: 1, queued: 1 });
    });
    await m.start(); // The report delivery starts the next run.
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["session_shutdown", "session_tree", "abort", "completed", "busy", "pending input"])("rechecks a pending reminder after %s", async (action) => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY - 1);
    if (action === "abort") m.controller.abort();
    else if (action === "completed") await m.execute("task_done", { taskId: "1" });
    else if (action === "busy") m.ctx.isIdle.mockReturnValue(false);
    else if (action === "pending input") m.ctx.hasPendingMessages.mockReturnValue(true);
    else await m.fire(action);
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("restarts the idle delay when another run starts", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY - 1);
    await m.start();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resets run state across session replacement without waking on startup", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.fire("session_shutdown");
    await m.fire("session_start", { reason: "reload" });
    await m.fire("agent_settled");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.start();
    await m.finish();
    await vi.advanceTimersByTimeAsync(NUDGE_DELAY);
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
