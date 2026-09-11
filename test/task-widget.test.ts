import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
  } = {
    widgets: new Map(),
    statuses: new Map(),
  };

  const ctx: UICtx = {
    setWidget(key, content, options) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
  };

  return { ctx, state };
}

/** Render the widget and return its lines. */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
  const entry = state.widgets.get("tasks");
  if (!entry?.content) return [];
  const theme = mockTheme();
  const tui = { terminal: { columns: 200 }, requestRender() {} };
  const result = entry.content(tui, theme);
  return result.render();
}

describe("TaskWidget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows leaf progress and connectors alongside active direct subtasks", () => {
    const project = store.create("Project", "Desc", undefined, undefined, undefined, { kind: "group" });
    const first = store.create("First", "Desc", undefined, undefined, undefined, { parentId: project.id });
    const second = store.create("Second", "Desc", "Building", undefined, undefined, { parentId: project.id });
    store.update(first.id, { status: "completed" });
    store.update(second.id, { status: "in_progress" });
    widget.setActiveTask(second.id);
    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("1/2 subtasks");
    expect(lines[0]).toContain("50%");
    expect(lines.find(line => line.includes("Project"))).toContain("1/2 · 50%");
    expect(lines.find(line => line.includes("First"))).toContain("├─ ");
    expect(lines.find(line => line.includes("Building…"))).toContain("└─ ");
    store.update(second.id, { status: "completed" });
    widget.update();
    expect(renderWidget(ui.state)[0]).toContain("2/2 subtasks");
  });

  it("keeps tree siblings in task order when a later sibling completes", () => {
    const group = store.create("Project", "Desc", undefined, undefined, undefined, { kind: "group" });
    const first = store.create("First", "Desc", undefined, undefined, undefined, { parentId: group.id });
    const second = store.create("Second", "Desc", undefined, undefined, undefined, { parentId: group.id });
    store.update(second.id, { status: "completed" });
    widget.update();
    const lines = renderWidget(ui.state);
    expect(lines.findIndex(line => line.includes(`#${first.id} `))).toBeLessThan(lines.findIndex(line => line.includes(`#${second.id} `)));
  });

  it("shows nothing when no tasks exist", () => {
    widget.update();
    const entry = ui.state.widgets.get("tasks");
    expect(entry?.content).toBeUndefined();
  });

  it("renders pending tasks with ◻ icon", () => {
    store.create("Do something", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(2); // header + 1 task
    expect(lines[0]).toContain("1 tasks");
    expect(lines[0]).toContain("1 open");
    expect(lines[1]).toContain("◻");
    expect(lines[1]).toContain("Do something");
  });

  it("renders in-progress tasks with ◼ icon", () => {
    store.create("Working on it", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Working on it");
  });

  it("renders completed tasks with ✔ icon and strikethrough", () => {
    store.create("Done task", "Desc");
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Done task~~");
  });

  it("renders active tasks with spinner icon", () => {
    store.create("Running thing", "Desc", "Processing data");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    // Should show activeForm text with "…" suffix
    expect(lines[1]).toContain("Processing data…");
    // Should NOT show ◼ for active task
    expect(lines[1]).not.toContain("◼");
  });

  it("shows blocked-by info for pending tasks", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).toContain("blocked by #1");
  });

  it("shows only immediate blockers when another direct edge is transitively redundant", () => {
    store.create("Root", "Desc");
    store.create("Middle", "Desc");
    store.create("Dependent", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("3", { addBlockedBy: ["1", "2"] });
    widget.update();

    const lines = renderWidget(ui.state);
    const dependentLine = lines.find(line => line.includes("Dependent"));
    expect(dependentLine).toContain("blocked by #2");
    expect(dependentLine).not.toContain("#1");
  });

  it("hides completed blockers in blocked-by suffix", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).not.toContain("blocked by");
  });

  it("shows status summary in header", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");
    store.create("Task C", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("3 tasks");
    expect(lines[0]).toContain("1 done");
    expect(lines[0]).toContain("1 in progress");
    expect(lines[0]).toContain("1 open");
  });

  it.each([
    [12, 6, 1, 50],
    [3, 1, 1, 33],
    [3, 2, 0, 67],
    [2, 0, 1, 0],
    [2, 2, 0, 100],
  ])("calculates completion for %i tasks with %i done and %i in progress", (total, done, active, percent) => {
    for (let i = 1; i <= total; i++) {
      store.create(`Task ${i}`, "Desc");
      if (i <= done) store.update(String(i), { status: "completed" });
      else if (i <= done + active) store.update(String(i), { status: "in_progress" });
    }
    widget.update();

    expect(renderWidget(ui.state)[0]).toContain(` - ${percent}%`);
    if (total === 12) {
      expect(renderWidget(ui.state)[0]).toContain("12 tasks (6 done, 1 in progress, 5 open) - 50%");
    }
  });

  it("clears widget when all tasks are deleted", () => {
    store.create("Task", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    store.update("1", { status: "deleted" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("limits the default widget to five visible tasks", () => {
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 5 tasks + status-aware overflow
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain("10 hidden (10 open)");
  });

  it("respects maxVisible config as the total task limit", () => {
    widget = new TaskWidget(store, { maxVisible: 8 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 8 tasks + status-aware overflow
    expect(lines).toHaveLength(10);
    expect(lines[9]).toContain("7 hidden (7 open)");
  });

  it("shows up to two completed tasks, one current task, and the next pending tasks", () => {
    for (let i = 1; i <= 4; i++) store.create(`Done ${i}`, "Desc");
    store.create("Current", "Desc");
    for (let i = 1; i <= 4; i++) store.create(`Future ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) store.update(String(i), { status: "completed" });
    store.update("5", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 2 newest completed + 1 current + 2 pending + overflow
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain("Done 3");
    expect(lines[2]).toContain("Done 4");
    expect(lines[3]).toContain("Current");
    expect(lines[4]).toContain("Future 1");
    expect(lines[5]).toContain("Future 2");
    expect(lines[6]).toContain("4 hidden (2 done, 2 open)");
  });

  it("uses all five slots for current and pending tasks when none are completed", () => {
    store.create("Current", "Desc");
    for (let i = 1; i <= 6; i++) store.create(`Future ${i}`, "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain("Current");
    expect(lines[5]).toContain("Future 4");
    expect(lines[6]).toContain("2 hidden (2 open)");
  });

  it("shows the next queued task beside four in-progress tasks", () => {
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) {
      store.update(String(i), { status: "in_progress", owner: `worker-${i}` });
    }
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("4 in progress");
    expect(lines[0]).toContain("1 open");
    expect(lines[5]).toContain("◻");
    expect(lines[5]).toContain("#5 Task 5");
    expect(lines.some(line => line.includes("hidden"))).toBe(false);
  });

  it("uses a second completed slot when unfinished work leaves room", () => {
    for (let i = 1; i <= 5; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 3; i++) store.create(`Future ${i}`, "Desc");
    for (let i = 1; i <= 5; i++) store.update(String(i), { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 2 newest completed + 3 unfinished + overflow
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain("3 hidden (3 done)");
    expect(lines.some(l => l.includes("Done 3"))).toBe(false);
    expect(lines.some(l => l.includes("Done 4"))).toBe(true);
    expect(lines.some(l => l.includes("Done 5"))).toBe(true);
    expect(lines.some(l => l.includes("Future 3"))).toBe(true);
  });

  it("summarizes mixed hidden task statuses", () => {
    widget = new TaskWidget(store, { maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 5; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 3; i++) store.create(`Future ${i}`, "Desc");
    for (let i = 1; i <= 5; i++) store.update(String(i), { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[lines.length - 1]).toContain("5 hidden (3 done, 2 open)");
  });

  it("shows all tasks when limit exceeds task count", () => {
    widget = new TaskWidget(store, { maxVisible: 10 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 3; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks, no overflow
    expect(lines).toHaveLength(4);
    expect(lines[lines.length - 1]).not.toContain("hidden");
  });

  it("shows all tasks when showAll is true even with maxVisible set", () => {
    widget = new TaskWidget(store, { showAll: true, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 15 tasks, no overflow line
    expect(lines).toHaveLength(16);
    expect(lines[lines.length - 1]).not.toContain("hidden");
  });

  it("truncates from top when hiddenAt is 'top'", () => {
    widget = new TaskWidget(store, { hiddenAt: "top", showAll: false, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    // 4 completed, 2 in_progress, 2 pending = 8 total, limit 5
    for (let i = 1; i <= 4; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Working ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Todo ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) store.update(String(i), { status: "completed" });
    for (let i = 5; i <= 6; i++) store.update(String(i), { status: "in_progress", owner: `worker-${i}` });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + overflow line + 2 completed + 2 current + 1 pending = 7 lines
    expect(lines).toHaveLength(7);
    // overflow at top (after header)
    expect(lines[1]).toContain("3 hidden (2 done, 1 open)");
    // All in-progress tasks take priority over pending work.
    expect(lines.some(l => l.includes("Working 1"))).toBe(true);
    expect(lines.some(l => l.includes("Working 2"))).toBe(true);
    expect(lines.some(l => l.includes("Todo 1"))).toBe(false);
    expect(lines.some(l => l.includes("Todo 2"))).toBe(true);
    // the newest two completed tasks are visible
    expect(lines.some(l => l.includes("Done 2"))).toBe(false);
    expect(lines.some(l => l.includes("Done 3"))).toBe(true);
    expect(lines.some(l => l.includes("Done 4"))).toBe(true);
  });

  it("truncates from bottom by default", () => {
    widget = new TaskWidget(store, { maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks + overflow at bottom = 5 lines
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Task 1");
    expect(lines[3]).toContain("Task 3");
    expect(lines[4]).toContain("2 hidden (2 open)");
    expect(lines.some(l => l.includes("Task 4"))).toBe(false);
  });

  it("always groups completed, current, and pending tasks with ID order inside each group", () => {
    store.create("Current 1", "Desc");            // #1
    store.create("Completed 2", "Desc");          // #2
    store.create("Pending 3", "Desc");            // #3
    store.create("Pending 4", "Desc");            // #4
    store.create("Completed 5", "Desc");          // #5
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "completed" });
    store.update("5", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("#2 Completed 2");
    expect(lines[2]).toContain("#5 Completed 5");
    expect(lines[3]).toContain("#1 Current 1");
    expect(lines[4]).toContain("#3 Pending 3");
    expect(lines[5]).toContain("#4 Pending 4");
  });

  it("tracks token usage for active tasks", () => {
    store.create("Active task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500);
    widget.addTokenUsage(500, 300);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Running…"));
    expect(activeLine).toContain("↑ 1.5k");
    expect(activeLine).toContain("↓ 800");
  });

  it("deactivates a task with setActiveTask(id, false)", () => {
    store.create("Task", "Desc", "Doing work");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Should be active (spinner)
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Doing work…");

    widget.setActiveTask("1", false);
    lines = renderWidget(ui.state);
    // Should now show as regular in_progress (◼)
    expect(lines[1]).toContain("◼");
    expect(lines[1]).not.toContain("Doing work…");
  });

  it("prunes stale active IDs on update", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Complete the task externally
    store.update("1", { status: "completed" });
    widget.update();

    // Should render as completed, not active
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Task~~");
  });

  it("shows multiple in-progress tasks up to the configured limit", () => {
    store.create("Task A", "Desc", "Processing A");
    store.create("Task B", "Desc", "Processing B");
    store.update("1", { status: "in_progress", owner: "worker-a" });
    store.update("2", { status: "in_progress", owner: "worker-b" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(3);
    expect(lines.some(l => l.includes("Processing A…"))).toBe(true);
    expect(lines.some(l => l.includes("Processing B…"))).toBe(true);
    expect(lines.some(l => l.includes("hidden"))).toBe(false);
  });

  it("prioritizes in-progress tasks when parallel work exceeds the configured limit", () => {
    widget = new TaskWidget(store, { maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 4; i++) {
      store.create(`Task ${i}`, "Desc", `Processing ${i}`);
      store.update(String(i), { status: "in_progress", owner: `worker-${i}` });
      widget.setActiveTask(String(i), true);
    }

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(5);
    expect(lines.some(l => l.includes("Processing 1…"))).toBe(true);
    expect(lines.some(l => l.includes("Processing 2…"))).toBe(true);
    expect(lines.some(l => l.includes("Processing 3…"))).toBe(true);
    expect(lines[4]).toContain("1 hidden (1 in progress)");
  });

  it("distributes token usage across all active tasks", () => {
    store.create("Task A", "Desc", "A");
    store.create("Task B", "Desc", "B");
    store.update("1", { status: "in_progress", owner: "worker-a" });
    store.update("2", { status: "in_progress", owner: "worker-b" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    widget.addTokenUsage(100, 50);

    let lines = renderWidget(ui.state);
    expect(lines.find(l => l.includes("A…"))).toContain("↑ 100");
    expect(lines.find(l => l.includes("B…"))).toContain("↑ 100");

    store.update("1", { status: "completed" });
    widget.update();
    lines = renderWidget(ui.state);
    expect(lines.find(l => l.includes("B…"))).toContain("↑ 100");
  });

  it("dispose clears widget and timer", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.dispose();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("uses subject as fallback when no activeForm", () => {
    store.create("My Subject", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("My Subject…");
  });

  it("shows elapsed time but no token arrows when tokens are zero", () => {
    store.create("No tokens", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // No addTokenUsage calls — tokens stay at 0
    vi.advanceTimersByTime(5000);
    widget.update();

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Working…"));
    expect(activeLine).toContain("5s");
    expect(activeLine).not.toContain("↑");
    expect(activeLine).not.toContain("↓");
  });

  it("cleans up metrics when stale active IDs are pruned", () => {
    store.create("Task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(100, 50);

    // Delete task externally
    store.update("1", { status: "deleted" });
    widget.update();

    // Reactivate with same ID (new task) — should get fresh metrics
    store.create("Task 2", "Desc", "Running");  // ID 2
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    // Should not carry over old tokens
    expect(lines[1]).not.toContain("↑ 100");
  });

  it("indents task lines under header", () => {
    store.create("Indented task", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // Task line should start with 2 spaces
    expect(lines[1]).toMatch(/^\s{2}/);
  });

  it("widget is placed aboveEditor", () => {
    store.create("Task", "Desc");
    widget.update();

    const entry = ui.state.widgets.get("tasks");
    expect(entry?.options?.placement).toBe("aboveEditor");
  });
});

describe("formatDuration (via widget rendering)", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows seconds for short durations", () => {
    store.create("Quick", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(30_000); // 30s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("30s");
  });

  it("shows hours for long durations", () => {
    store.create("Long", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1h 2m"
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("1h 2m");
  });

  it("shows exact hours without minutes", () => {
    store.create("Exact", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(7_200_000); // 2h exactly
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2h)");
  });

  it("shows minutes and seconds", () => {
    store.create("Medium", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(169_000); // 2m 49s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2m 49s");
  });

  it("formats small token counts without k suffix", () => {
    store.create("Small", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(500, 200);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 500");
    expect(lines[1]).toContain("↓ 200");
  });

  it("formats token counts with k suffix and removes .0", () => {
    store.create("Large", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(2000, 4100);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 2k");    // 2000 → "2k" (not "2.0k")
    expect(lines[1]).toContain("↓ 4.1k");  // 4100 → "4.1k"
  });
});
