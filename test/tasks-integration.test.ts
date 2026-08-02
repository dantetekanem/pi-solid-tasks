import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycleHandlers = new Map<string, Array<(...args: any[]) => any>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(event: string, handler: (...args: any[]) => any) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventHandlers.set(channel, handlers);
        return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter(item => item !== handler));
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    async executeTool(name: string, params: any, ctx = mockCtx()) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
    async fireLifecycle(event: string, ...args: any[]) {
      for (const handler of lifecycleHandlers.get(event) ?? []) await handler(...args);
    },
  };
}

describe("session-scoped storage", () => {
  let tasksDir: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    delete process.env.PI_TASKS;
    tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-sessions-"));
    process.env.PI_TASKS_DIR = tasksDir;
  });

  afterEach(async () => {
    delete process.env.PI_TASKS_DIR;
    const fs = await import("node:fs");
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  it("stores each Pi session in its own folder", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" }, {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "session-a" },
    });
    await mock.executeTool("task_create", { subject: "A", description: "Task A" });

    await mock.fireLifecycle("session_start", { reason: "new" }, {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "session-b" },
    });
    await mock.executeTool("task_create", { subject: "B", description: "Task B" });

    expect(fs.existsSync(path.join(tasksDir, "sessions", "session-a", "tasks.json"))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, "sessions", "session-b", "tasks.json"))).toBe(true);
    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toContain("#1 [pending] B");
    expect(list.content[0].text).not.toContain("A");
  });
});

describe("/add-task", () => {
  it("creates a draft task and sends its refinement prompt", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const command = mock.commands.get("add-task");

    await command.handler("ship the manual task", { ...mockCtx(), isIdle: () => true });

    const task = await mock.executeTool("task_get", { taskId: "1" });
    expect(task.content[0].text).toContain("[draft] ship the manual task");
    expect(task.content[0].text).toContain("Manual draft task inserted with /add-task.");
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Improve the task by using task_update"));
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("inventory-first decomposition contract"));
  });

  it("queues the refinement prompt when the agent is busy", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.commands.get("add-task").handler("handle this next", { ...mockCtx(), isIdle: () => false });
    expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
  });
});

describe("core task tools", () => {
  it("registers tracking and process tools without task_execute", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    for (const name of ["task_create", "task_list", "task_get", "task_update", "tasks_done", "task_output", "task_stop"]) {
      expect(mock.tools.has(name)).toBe(true);
    }
    expect(mock.tools.has("task_execute")).toBe(false);
  });

  it("requires discovery tasks to expand repeated work into bounded execution tasks", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const taskCreate = mock.tools.get("task_create");
    const guidance = [taskCreate.description, ...taskCreate.promptGuidelines].join("\n");

    expect(guidance).toContain("inventory task");
    expect(guidance).toContain("more than five");
    expect(guidance).toContain("before changing any discovered item");
    expect(guidance).toContain("Do not perform the discovered bulk execution inside the inventory task");
    expect(guidance).toContain("4–5 items");
    expect(guidance).toContain("exact items");
    expect(guidance).toContain("keep pending follow-up tasks visible");
    expect(guidance).not.toContain("Keep one top-level task in_progress");
  });

  it("enforces task order and clears only fully completed lists", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });

    const skipped = await mock.executeTool("task_update", { taskId: "2", status: "in_progress" });
    expect(skipped.content[0].text).toContain("cannot start while earlier tasks remain unfinished");

    const unfinished = await mock.executeTool("tasks_done", {});
    expect(unfinished.content[0].text).toContain("unfinished tasks remain");

    await mock.executeTool("task_update", { taskId: "1", status: "completed" });
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    expect((await mock.executeTool("tasks_done", {})).content[0].text).toContain("Cleared 2 completed tasks");
  });

  it("keeps arbitrary metadata without an agent-specific shortcut", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", {
      subject: "Metadata",
      description: "desc",
      metadata: { source: "manual" },
    });
    const task = await mock.executeTool("task_get", { taskId: "1" });
    expect(task.content[0].text).toContain('Metadata: {"source":"manual"}');
  });

  it("creates tasks before, after, at the beginning, or at the end of open work", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const taskCreate = mock.tools.get("task_create");

    expect(taskCreate.parameters.properties.position).toBeDefined();
    expect(taskCreate.description).toContain("beginning of open tasks");
    expect(taskCreate.description).toContain("end of open tasks");

    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });
    await mock.executeTool("task_create", { subject: "Third", description: "desc" });
    await mock.executeTool("task_create", {
      subject: "Before second",
      description: "desc",
      position: { type: "before", taskId: "2" },
    });
    await mock.executeTool("task_create", {
      subject: "After second",
      description: "desc",
      position: { type: "after", taskId: "2" },
    });
    await mock.executeTool("task_create", {
      subject: "Beginning",
      description: "desc",
      position: { type: "beginning" },
    });
    await mock.executeTool("task_create", {
      subject: "Explicit end",
      description: "desc",
      position: { type: "end" },
    });
    await mock.executeTool("task_create", { subject: "Default end", description: "desc" });

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text.split("\n").map((line: string) => line.match(/#(\d+)/)?.[1])).toEqual([
      "6",
      "1",
      "4",
      "2",
      "5",
      "3",
      "7",
      "8",
    ]);
  });

  it("enforces positioned task order instead of numeric ID order", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });
    await mock.executeTool("task_create", {
      subject: "Inserted before second",
      description: "desc",
      position: { type: "before", taskId: "2" },
    });
    await mock.executeTool("task_update", { taskId: "1", status: "completed" });

    const skipped = await mock.executeTool("task_update", { taskId: "2", status: "in_progress" });
    expect(skipped.content[0].text).toContain("#3 [pending]");

    const inserted = await mock.executeTool("task_update", { taskId: "3", status: "in_progress" });
    expect(inserted.content[0].text).toContain("Updated task #3 status");
  });

  it("rejects missing or completed position anchors without creating a task", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "Completed", description: "desc" });
    await mock.executeTool("task_update", { taskId: "1", status: "completed" });

    const missing = await mock.executeTool("task_create", {
      subject: "Missing anchor",
      description: "desc",
      position: { type: "before", taskId: "999" },
    });
    expect(missing.content[0].text).toContain("Task #999 not found");

    const completed = await mock.executeTool("task_create", {
      subject: "Completed anchor",
      description: "desc",
      position: { type: "after", taskId: "1" },
    });
    expect(completed.content[0].text).toContain("Task #1 is completed");

    const created = await mock.executeTool("task_create", { subject: "Valid", description: "desc" });
    expect(created.content[0].text).toContain("Task #2 created successfully");
  });
});
