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
      let result: any;
      for (const handler of lifecycleHandlers.get(event) ?? []) result = await handler(...args);
      return result;
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

describe("nested task tools", () => {
  it("creates groups and subtasks, exposes progress, and clears only on request", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "Project", description: "desc", kind: "group" });
    const rejected = await mock.executeTool("task_create", { subject: "Subgroup", description: "desc", kind: "group", parentId: "1" });
    expect(rejected.content[0].text).toContain("one level only");
    await mock.executeTool("task_create", { subject: "First", description: "desc", parentId: "1" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc", parentId: "1" });
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    const list = (await mock.executeTool("task_list", {})).content[0].text;
    expect(list).toContain("#1 [in_progress] Project [1/2 subtasks · 50%]");
    expect(list).toContain("├─ #2 [completed] First");
    expect(list).toContain("└─ #3 [pending] Second");
    const child = (await mock.executeTool("task_get", { taskId: "3" })).content[0].text;
    expect(child).toContain("Parent: #1");
    expect((await mock.executeTool("tasks_done", {})).content[0].text).toContain("unfinished");
    await mock.executeTool("task_update", { taskId: "3", status: "completed" });
    for (let i = 0; i < 8; i++) await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("before_agent_start", {}, mockCtx());
    expect((await mock.executeTool("task_get", { taskId: "1" })).content[0].text).toContain("Progress: 2/2 subtasks · 100%");
    await mock.fireLifecycle("tool_result", { toolName: "read" });
    // Retained completed projects are history, not unfinished work reminders.
    expect(await mock.fireLifecycle("context", { messages: [] })).toEqual({});
    expect((await mock.executeTool("tasks_done", {})).content[0].text).toContain("Cleared 3 completed tasks");
  });

  it("keeps tree sibling order separate from the execution queue after completion", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "Project", description: "desc", kind: "group" });
    await mock.executeTool("task_create", { subject: "First", description: "desc", parentId: "1" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc", parentId: "1" });
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    const list = (await mock.executeTool("task_list", {})).content[0].text;
    expect(list.indexOf("#2 [completed]")).toBeLessThan(list.indexOf("#3 [pending]"));
    expect(list).toContain("Execution queue: #3");
    const ctx = mockCtx();
    const select = vi.fn().mockResolvedValueOnce("View all tasks (3)").mockResolvedValue(undefined);
    await mock.commands.get("tasks").handler("", { ...ctx, ui: { ...ctx.ui, select } });
    expect(select.mock.calls[1][1].slice(0, 3).map((line: string) => line.match(/#(\d+)/)?.[1])).toEqual(["1", "2", "3"]);
  });

  it.each(["999", ""])("reports invalid parent %j without adding a task", async (parentId) => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const result = await mock.executeTool("task_create", { subject: "Child", description: "desc", parentId });
    expect(result.content[0].text).toMatch(/parent/i);
    expect((await mock.executeTool("task_list", {})).content[0].text).toBe("No tasks found");
  });

  it("creates an issue group and child through /tasks", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx();
    const select = vi.fn()
      .mockResolvedValueOnce("Create group")
      .mockResolvedValueOnce("View all tasks (1)")
      .mockImplementationOnce((_title, choices) => choices[0])
      .mockResolvedValueOnce("Add subtask")
      .mockResolvedValueOnce(undefined);
    const input = vi.fn()
      .mockResolvedValueOnce("Project").mockResolvedValueOnce("Acceptance")
      .mockResolvedValueOnce("Build it").mockResolvedValueOnce("Verified build");
    await mock.commands.get("tasks").handler("", { ...ctx, ui: { ...ctx.ui, select, input } });
    expect((await mock.executeTool("task_get", { taskId: "2" })).content[0].text).toContain("Parent: #1");
    expect((await mock.executeTool("task_get", { taskId: "1" })).content[0].text).toContain("Progress: 0/1 subtasks · 0%");
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
    expect(guidance).toContain("ready independent tasks");
    expect(guidance).toContain("all declared dependencies");
    expect(guidance).toContain("distinct owner");
    expect(guidance).not.toContain("exactly the earliest runnable task in_progress");
    expect(guidance).not.toContain("Keep one top-level task in_progress");
  });

  it("describes ready parallel ownership and all-of dependency semantics", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const descriptions = ["task_list", "task_get", "task_update"]
      .map(name => mock.tools.get(name).description)
      .join("\n");

    expect(descriptions).toContain("ready");
    expect(descriptions).toContain("parallel");
    expect(descriptions).toContain("all");
    expect(descriptions).toContain("owner");
    expect(descriptions).toContain("blockedBy");
    expect(descriptions).toContain("immediate prerequisites");
    expect(descriptions).toContain("redundant transitive");
    expect(descriptions).toContain("earlier");
    expect(descriptions).toContain("actively owned by another owner");
    expect(descriptions).toContain("At most 4 tasks can be in progress at once");
  });

  it("keeps outside-milestone findings nonblocking while preserving genuine prerequisites", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const taskCreate = mock.tools.get("task_create");
    const guidance = [taskCreate.description, ...taskCreate.promptGuidelines].join("\n");

    expect(guidance).toContain("frozen acceptance criteria");
    expect(guidance).toContain("threat model");
    expect(guidance).toContain("exercised slice");
    expect(guidance).toContain("fix a failure in the currently exercised slice");
    expect(guidance).toContain("genuine prerequisite");
    expect(guidance).toContain("immediate data loss, privacy/security breach, or irreversibility");
    expect(guidance).toContain("pending, nonblocking follow-ups");
    expect(guidance).toContain("append them after current milestone work");
    expect(guidance).toContain("do not move them ahead");
    expect(guidance).toContain("or serialize unrelated hardening before a user-visible vertical slice");
    expect(guidance).toContain("Never use this rule to skip genuinely blocking work");
    expect(guidance).toContain("append outside-scope follow-ups after existing work");
    expect(guidance).toContain("only when they are genuine prerequisites");
    expect(guidance).toContain("all declared blockedBy dependencies must be completed");
    expect(guidance).toContain("distinct owner");
    expect(guidance).toContain("finish or undo its current task before claiming another");
    expect(guidance).toContain("add only immediate prerequisites with addBlockedBy");
  });

  it("requires each owner to finish or undo its current task before moving on", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const taskCreate = mock.tools.get("task_create");
    const taskUpdate = mock.tools.get("task_update");
    const guidance = [
      taskCreate.description,
      ...taskCreate.promptGuidelines,
      taskUpdate.description,
    ].join("\n");

    expect(guidance).toContain("finish or undo");
    expect(guidance).toContain("before claiming another task");
    expect(guidance).toContain("undo every change and side effect");
    expect(guidance).toContain("delete the task");
    expect(guidance).not.toContain("keep the task as in_progress");
    expect(guidance).not.toContain("unless it is explicitly handed off");
    expect(taskUpdate.parameters.properties.status.enum).toEqual(["in_progress", "completed", "deleted"]);
  });

  it("starts independent tasks concurrently and clears only fully completed lists", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });

    const first = await mock.executeTool("task_update", { taskId: "1", status: "in_progress", owner: "researcher" });
    const second = await mock.executeTool("task_update", { taskId: "2", status: "in_progress", owner: "team-lead" });
    expect(first.content[0].text).toContain("Updated task #1 status, owner");
    expect(second.content[0].text).toContain("Updated task #2 status, owner");

    const unfinished = await mock.executeTool("tasks_done", {});
    expect(unfinished.content[0].text).toContain("unfinished tasks remain");

    await mock.executeTool("task_update", { taskId: "1", status: "completed" });
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    expect((await mock.executeTool("tasks_done", {})).content[0].text).toContain("Cleared 2 completed tasks");
  });

  it("keeps a fifth parallel task queued until one of four running tasks finishes", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    for (let i = 1; i <= 5; i++) {
      await mock.executeTool("task_create", { subject: `Task ${i}`, description: "desc" });
    }
    for (let i = 1; i <= 4; i++) {
      await mock.executeTool("task_update", {
        taskId: String(i),
        status: "in_progress",
        owner: `worker-${i}`,
      });
    }

    const queued = await mock.executeTool("task_update", {
      taskId: "5",
      status: "in_progress",
      owner: "worker-5",
    });
    expect(queued.content[0].text).toContain("At most 4 tasks can be in progress at once");
    expect((await mock.executeTool("task_get", { taskId: "5" })).content[0].text).toContain("Status: pending");

    await mock.executeTool("task_update", { taskId: "1", status: "completed" });
    const started = await mock.executeTool("task_update", {
      taskId: "5",
      status: "in_progress",
      owner: "worker-5",
    });
    expect(started.content[0].text).toContain("Updated task #5 status, owner");
  });

  it("waits for every prerequisite while unrelated work continues", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "Research A", description: "desc" });
    await mock.executeTool("task_create", { subject: "Research B", description: "desc" });
    await mock.executeTool("task_create", { subject: "Unrelated implementation", description: "desc" });
    await mock.executeTool("task_create", { subject: "Integrate research", description: "desc" });
    await mock.executeTool("task_update", { taskId: "4", addBlockedBy: ["1", "2"] });

    await mock.executeTool("task_update", { taskId: "1", status: "in_progress", owner: "researcher-a" });
    await mock.executeTool("task_update", { taskId: "2", status: "in_progress", owner: "researcher-b" });
    await mock.executeTool("task_update", { taskId: "3", status: "in_progress", owner: "team-lead" });

    const bothOpen = await mock.executeTool("task_update", { taskId: "4", status: "in_progress" });
    expect(bothOpen.content[0].text).toContain("blocked by #1, #2");

    await mock.executeTool("task_update", { taskId: "1", status: "completed" });
    const oneOpen = await mock.executeTool("task_update", { taskId: "4", status: "in_progress" });
    expect(oneOpen.content[0].text).toContain("blocked by #2");

    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    const unblocked = await mock.executeTool("task_update", { taskId: "4", status: "in_progress", owner: "integrator" });
    expect(unblocked.content[0].text).toContain("Updated task #4 status, owner");

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text).toContain("#3 [in_progress] Unrelated implementation (team-lead)");
    expect(list.content[0].text).toContain("#4 [in_progress] Integrate research (integrator)");
    expect(list.content[0].text).not.toContain("#4 [in_progress] Integrate research (integrator) [blocked by");
  });

  it("shows only immediate blockers and enforces the transitive completion chain", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "Unrelated", description: "desc" });
    await mock.executeTool("task_create", { subject: "Task 2", description: "desc" });
    await mock.executeTool("task_create", { subject: "Task 3", description: "desc" });
    await mock.executeTool("task_create", { subject: "Task 4", description: "desc" });
    await mock.executeTool("task_update", { taskId: "3", addBlockedBy: ["2"] });
    await mock.executeTool("task_update", { taskId: "4", addBlockedBy: ["2", "3"] });

    const list = await mock.executeTool("task_list", {});
    const task4Line = list.content[0].text.split("\n").find((line: string) => line.startsWith("#4 "));
    expect(task4Line).toContain("[blocked by #3]");
    expect(task4Line).not.toContain("#2");

    const task2 = await mock.executeTool("task_get", { taskId: "2" });
    const task4 = await mock.executeTool("task_get", { taskId: "4" });
    expect(task2.content[0].text).toContain("Blocks: #3");
    expect(task2.content[0].text).not.toContain("#4");
    expect(task4.content[0].text).toContain("Blocked by: #3");
    expect(task4.content[0].text).not.toContain("#2");

    await mock.executeTool("task_update", { taskId: "1", status: "in_progress", owner: "unrelated-owner" });
    const earlyCompletion = await mock.executeTool("task_update", { taskId: "3", status: "completed" });
    expect(earlyCompletion.content[0].text).toContain("cannot complete; blocked by #2");
    await mock.executeTool("task_update", { taskId: "2", status: "completed" });
    await mock.executeTool("task_update", { taskId: "3", status: "completed" });
    const started = await mock.executeTool("task_update", { taskId: "4", status: "in_progress", owner: "integrator" });
    expect(started.content[0].text).toContain("Updated task #4 status");
  });

  it("rejects invalid dependency graphs without persisting partial reciprocal edges", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "A", description: "desc" });
    await mock.executeTool("task_create", { subject: "B", description: "desc" });
    await mock.executeTool("task_update", { taskId: "1", addBlocks: ["2"] });

    const rejected = await mock.executeTool("task_update", { taskId: "2", addBlocks: ["1"] });
    expect(rejected.content[0].text).toMatch(/cycle/i);

    const a = await mock.executeTool("task_get", { taskId: "1" });
    const b = await mock.executeTool("task_get", { taskId: "2" });
    expect(a.content[0].text).toContain("Blocks: #2");
    expect(a.content[0].text).not.toContain("Blocked by: #2");
    expect(b.content[0].text).toContain("Blocked by: #1");
    expect(b.content[0].text).not.toContain("Blocks: #1");
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

  it("blocks positioned later work until earlier entries are active under other owners", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("task_create", { subject: "First", description: "desc" });
    await mock.executeTool("task_create", { subject: "Second", description: "desc" });
    await mock.executeTool("task_create", {
      subject: "Inserted before second",
      description: "desc",
      position: { type: "before", taskId: "2" },
    });

    const skipped = await mock.executeTool("task_update", { taskId: "2", status: "in_progress", owner: "later-owner" });
    expect(skipped.content[0].text).toContain("cannot start before earlier tasks #1, #3");

    await mock.executeTool("task_update", { taskId: "1", status: "in_progress", owner: "first-owner" });
    await mock.executeTool("task_update", { taskId: "3", status: "in_progress", owner: "inserted-owner" });
    const later = await mock.executeTool("task_update", { taskId: "2", status: "in_progress", owner: "later-owner" });
    expect(later.content[0].text).toContain("Updated task #2 status, owner");

    const list = await mock.executeTool("task_list", {});
    expect(list.content[0].text.split("\n").map((line: string) => line.match(/#(\d+)/)?.[1])).toEqual(["1", "3", "2"]);
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
