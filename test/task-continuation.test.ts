import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function setup() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const controller = new AbortController();
  const ctx = {
    isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false), signal: controller.signal,
    sessionManager: { getSessionId: () => "session-a" },
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
  it("wakes once per settled run until all tasks finish, without claiming or completing work", async () => {
    const m = setup();
    await m.execute("tasks_create_in_batch", { tasks: [
      { subject: "First", description: "First evidence" }, { subject: "Second", description: "Second evidence" },
    ] });
    await m.start();
    await m.fire("agent_end");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.finish();
    await m.fire("agent_settled");
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(m.pi.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      customType: "tasks-continuation", details: { taskIds: ["1", "2"] },
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect((await m.execute("task_get", { taskId: "1" })).content[0].text).toContain("Status: pending");

    await m.start();
    await m.execute("task_update", { taskId: "1", status: "in_progress", owner: "lead" });
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(2);
    await m.start();
    await m.execute("task_done", { taskId: "1" });
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(3);
    expect(m.pi.sendMessage.mock.lastCall?.[0].details).toEqual({ taskIds: ["2"] });
    await m.start();
    await m.execute("task_done", { taskId: "2" });
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not wake an empty queue, but does wake an unfinished empty group", async () => {
    const m = setup();
    await m.start();
    await m.finish();
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.execute("task_create", { kind: "group", subject: "Project", description: "Needs children" });
    await m.start();
    await m.finish();
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
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("honors Escape during a tool even when the last assistant stop reason is toolUse", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    m.controller.abort();
    await m.finish("toolUse");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("holds a concrete task question until real user input, not an extension follow-up", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Publish", description: "Needs permission" });
    await m.start();
    const result = await m.execute("task_wait", { taskId: "1", question: "May I publish this change?" });
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ taskId: "1", question: "May I publish this change?" });
    await m.finish("toolUse");
    await m.fire("input", { source: "extension", text: "Report arrived" });
    await m.start();
    await m.finish();
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.fire("input", { source: "interactive", text: "Yes" });
    await m.start();
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty question or a missing/completed task without disabling continuation", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await expect(m.execute("task_wait", { taskId: "1", question: "   " })).rejects.toThrow();
    await expect(m.execute("task_wait", { taskId: "999", question: "May I publish?" })).rejects.toThrow();
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
    await m.execute("task_done", { taskId: "1" });
    await expect(m.execute("task_wait", { taskId: "1", question: "May I publish?" })).rejects.toThrow();
  });

  it("releases a question hold when the blocked task is completed elsewhere", async () => {
    const m = setup();
    await m.execute("tasks_create_in_batch", { tasks: [
      { subject: "Question", description: "Desc" }, { subject: "Next", description: "Desc" },
    ] });
    await m.start();
    await m.execute("task_wait", { taskId: "1", question: "Which target?" });
    await m.execute("task_done", { taskId: "1" });
    await m.finish();
    expect(m.pi.sendMessage.mock.lastCall?.[0].details).toEqual({ taskIds: ["2"] });
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
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.fire("ui_prompt_end");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.fire("tool_execution_end", { toolName: "ask_user", toolCallId: "q", result: { details: { cancelled: true } } });
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
    expect(m.pi.events.emit).toHaveBeenCalledWith("pi-extended-teams:child-agent-lifecycle-probe", expect.objectContaining({ sessionId: "session-a" }));
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    m.pi.events.emit.mockImplementation((_name, probe) => {
      probe.respond({ sessionId: "other-session", running: 1, queued: 1 });
    });
    await m.start(); // The report delivery starts the next run.
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resets wait and run state across session replacement without waking on startup", async () => {
    const m = setup();
    await m.execute("task_create", { subject: "Open", description: "Desc" });
    await m.start();
    await m.execute("task_wait", { taskId: "1", question: "Which target?" });
    await m.fire("session_shutdown");
    await m.fire("session_start", { reason: "reload" });
    await m.fire("agent_settled");
    expect(m.pi.sendMessage).not.toHaveBeenCalled();
    await m.start();
    await m.finish();
    expect(m.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
