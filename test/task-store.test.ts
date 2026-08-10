import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(); // no listId = in-memory
  });

  it("creates tasks with auto-incrementing IDs", () => {
    const t1 = store.create("First task", "Description 1");
    const t2 = store.create("Second task", "Description 2");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t1.subject).toBe("First task");
    expect(t1.description).toBe("Description 1");
  });

  it("creates tasks with optional fields", () => {
    const t = store.create("Task", "Desc", "Running task", { key: "value" });

    expect(t.activeForm).toBe("Running task");
    expect(t.metadata).toEqual({ key: "value" });
  });

  it("creates tasks at the end of open work by default or explicitly", () => {
    store.create("First", "Desc");
    store.create("Second", "Desc");
    store.create("Beginning", "Desc", undefined, undefined, { type: "beginning" });
    store.create("Default end", "Desc");
    store.create("Explicit end", "Desc", undefined, undefined, { type: "end" });

    expect(store.list().map(task => task.subject)).toEqual([
      "Beginning",
      "First",
      "Second",
      "Default end",
      "Explicit end",
    ]);
  });

  it("creates tasks before and after an open task", () => {
    store.create("First", "Desc");
    const second = store.create("Second", "Desc");
    store.create("Third", "Desc");

    store.create("Before second", "Desc", undefined, undefined, { type: "before", taskId: second.id });
    store.create("After second", "Desc", undefined, undefined, { type: "after", taskId: second.id });

    expect(store.list().map(task => task.subject)).toEqual([
      "First",
      "Before second",
      "Second",
      "After second",
      "Third",
    ]);
  });

  it("positions beginning and end relative to open tasks, ahead of completed tasks", () => {
    const completed = store.create("Completed", "Desc");
    store.update(completed.id, { status: "completed" });
    store.create("Existing open", "Desc");

    store.create("Beginning", "Desc", undefined, undefined, { type: "beginning" });
    store.create("End", "Desc", undefined, undefined, { type: "end" });

    expect(store.list().map(task => task.subject)).toEqual([
      "Beginning",
      "Existing open",
      "End",
      "Completed",
    ]);
  });

  it("rejects missing and completed position anchors without consuming an ID", () => {
    const completed = store.create("Completed", "Desc");
    store.update(completed.id, { status: "completed" });

    expect(() => store.create("Missing anchor", "Desc", undefined, undefined, {
      type: "before",
      taskId: "999",
    })).toThrow("Task #999 not found");
    expect(() => store.create("Completed anchor", "Desc", undefined, undefined, {
      type: "after",
      taskId: completed.id,
    })).toThrow("Task #1 is completed");

    expect(store.create("Next valid task", "Desc").id).toBe("2");
  });

  it("gets a task by ID", () => {
    store.create("Test", "Desc");
    const task = store.get("1");

    expect(task).toBeDefined();
    expect(task!.subject).toBe("Test");
  });

  it("returns undefined for non-existent task", () => {
    expect(store.get("999")).toBeUndefined();
  });

  it("lists tasks sorted by ID when requested", () => {
    store.create("Task 3", "Desc");
    store.create("Task 1", "Desc");
    store.create("Task 2", "Desc");

    const tasks = store.list("id");
    expect(tasks.map(t => t.id)).toEqual(["1", "2", "3"]);
  });

  it("lists tasks sorted by status when sortOrder is 'status'", () => {
    store.create("In progress", "Desc");       // #1
    store.create("Completed", "Desc");         // #2
    store.create("Pending", "Desc");           // #3
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "completed" });

    const tasks = store.list("status");
    expect(tasks.map(t => t.subject)).toEqual(["Completed", "In progress", "Pending"]);
  });

  it("lists tasks sorted by most recently updated when sortOrder is 'recent'", () => {
    vi.useFakeTimers({ now: 1000 });
    store.create("First", "Desc");    // #1 created at 1000
    vi.advanceTimersByTime(100);
    store.create("Second", "Desc");   // #2 created at 1100
    vi.advanceTimersByTime(100);
    store.create("Third", "Desc");    // #3 created at 1200
    vi.advanceTimersByTime(100);
    store.update("1", { subject: "First updated" });  // #1 updated at 1300
    vi.advanceTimersByTime(100);
    store.update("3", { subject: "Third updated" });  // #3 updated at 1400

    const tasks = store.list("recent");
    // Most recently updated first: #3 (1400), #1 (1300), #2 (1100)
    expect(tasks.map(t => t.id)).toEqual(["3", "1", "2"]);
    vi.useRealTimers();
  });

  it("lists tasks sorted by least recently updated when sortOrder is 'oldest'", () => {
    vi.useFakeTimers({ now: 1000 });
    store.create("First", "Desc");    // #1 created at 1000
    vi.advanceTimersByTime(100);
    store.create("Second", "Desc");   // #2 created at 1100
    vi.advanceTimersByTime(100);
    store.create("Third", "Desc");    // #3 created at 1200
    vi.advanceTimersByTime(100);
    store.update("1", { subject: "First updated" });  // #1 updated at 1300
    vi.advanceTimersByTime(100);
    store.update("3", { subject: "Third updated" });  // #3 updated at 1400

    const tasks = store.list("oldest");
    // Least recently updated first: #2 (1100), #1 (1300), #3 (1400)
    expect(tasks.map(t => t.id)).toEqual(["2", "1", "3"]);
    vi.useRealTimers();
  });

  it("updates task status", () => {
    store.create("Test", "Desc");
    const { task, changedFields } = store.update("1", { status: "in_progress" });

    expect(task!.status).toBe("in_progress");
    expect(changedFields).toEqual(["status"]);
  });

  it("updates multiple fields at once", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", {
      subject: "Updated subject",
      description: "Updated desc",
      owner: "agent-1",
    });

    expect(changedFields).toContain("subject");
    expect(changedFields).toContain("description");
    expect(changedFields).toContain("owner");

    const task = store.get("1")!;
    expect(task.subject).toBe("Updated subject");
    expect(task.owner).toBe("agent-1");
  });

  it("deletes a task with status: deleted", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", { status: "deleted" });

    expect(changedFields).toEqual(["deleted"]);
    expect(store.get("1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("preserves ID counter after deletion", () => {
    store.create("Task 1", "Desc");
    store.create("Task 2", "Desc");
    store.update("1", { status: "deleted" });

    const t3 = store.create("Task 3", "Desc");
    expect(t3.id).toBe("3"); // Not "1" — counter continues
  });

  it("merges metadata with null key deletion", () => {
    store.create("Test", "Desc", undefined, { a: 1, b: 2, c: 3 });
    store.update("1", { metadata: { b: null, d: 4 } });

    const task = store.get("1")!;
    expect(task.metadata).toEqual({ a: 1, c: 3, d: 4 });
  });

  it("sets up bidirectional blocks via addBlocks", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");

    store.update("1", { addBlocks: ["2"] });

    const t1 = store.get("1")!;
    const t2 = store.get("2")!;
    expect(t1.blocks).toContain("2");
    expect(t2.blockedBy).toContain("1");
  });

  it("sets up bidirectional blocks via addBlockedBy", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");

    store.update("2", { addBlockedBy: ["1"] });

    const t1 = store.get("1")!;
    const t2 = store.get("2")!;
    expect(t1.blocks).toContain("2");
    expect(t2.blockedBy).toContain("1");
  });

  it("does not duplicate dependency edges", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");

    store.update("1", { addBlocks: ["2"] });
    store.update("1", { addBlocks: ["2"] }); // duplicate

    const t1 = store.get("1")!;
    expect(t1.blocks.filter(id => id === "2")).toHaveLength(1);
  });

  it("cleans up dependency edges on deletion", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });

    store.update("1", { status: "deleted" });

    const t2 = store.get("2")!;
    expect(t2.blockedBy).toEqual([]);
  });

  it("clears completed tasks", () => {
    store.create("Completed", "Desc");
    store.create("Pending", "Desc");
    store.update("1", { status: "completed" });

    const count = store.clearCompleted();

    expect(count).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].id).toBe("2");
  });

  it("returns not found for update on non-existent task", () => {
    const { task, changedFields } = store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
  });

  it("delete method works", () => {
    store.create("Test", "Desc");
    expect(store.delete("1")).toBe(true);
    expect(store.delete("1")).toBe(false); // already deleted
    expect(store.list()).toHaveLength(0);
  });

  it("creates tasks with metadata via task_create", () => {
    const t = store.create("With meta", "Desc", undefined, { pr: "123", reviewer: "alice" });
    expect(t.metadata).toEqual({ pr: "123", reviewer: "alice" });

    const retrieved = store.get("1")!;
    expect(retrieved.metadata).toEqual({ pr: "123", reviewer: "alice" });
  });

  it("rejects direct dependency cycles atomically", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });

    expect(() => store.update("2", { addBlocks: ["1"] })).toThrow(/cycle/i);
    expect(store.get("1")!.blocks).toEqual(["2"]);
    expect(store.get("1")!.blockedBy).toEqual([]);
    expect(store.get("2")!.blocks).toEqual([]);
    expect(store.get("2")!.blockedBy).toEqual(["1"]);
  });

  it("rejects transitive dependency cycles atomically", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.create("C", "Desc");
    store.update("1", { addBlocks: ["2"] });
    store.update("2", { addBlocks: ["3"] });
    const before = structuredClone(store.list("id"));

    expect(() => store.update("3", {
      subject: "Must stay C",
      metadata: { attempted: true },
      addBlocks: ["1"],
    })).toThrow(/cycle/i);
    expect(store.list("id")).toEqual(before);
  });

  it("rejects self-dependencies through either update direction", () => {
    store.create("Self", "Desc");
    const before = structuredClone(store.get("1"));

    expect(() => store.update("1", { addBlocks: ["1"] })).toThrow(/itself/i);
    expect(store.get("1")).toEqual(before);
    expect(() => store.update("1", { addBlockedBy: ["1"] })).toThrow(/itself/i);
    expect(store.get("1")).toEqual(before);
  });

  it("rejects a mixed addBlocks batch without partially mutating fields or edges", () => {
    store.create("A", "Desc", undefined, { original: true });
    store.create("B", "Desc");
    const before = structuredClone(store.list("id"));

    expect(() => store.update("1", {
      subject: "Must stay A",
      metadata: { original: null, attempted: true },
      addBlocks: ["2", "9999"],
    })).toThrow(/#9999/);
    expect(store.list("id")).toEqual(before);
  });

  it("rejects a mixed addBlockedBy batch without partial reciprocal edges", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.create("Dependent", "Desc");
    const before = structuredClone(store.list("id"));

    expect(() => store.update("3", { addBlockedBy: ["1", "9999", "2"] })).toThrow(/#9999/);
    expect(store.list("id")).toEqual(before);
  });

  it("returns no warnings for valid dependencies", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    const { warnings } = store.update("1", { addBlocks: ["2"] });
    expect(warnings).toEqual([]);
  });

  it("accepts whitespace-only subjects (matches Claude Code)", () => {
    const t = store.create("   ", "Desc");
    expect(t.subject).toBe("   ");
  });

  it("updates activeForm field", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", { activeForm: "Running tests" });
    expect(changedFields).toContain("activeForm");
    expect(store.get("1")!.activeForm).toBe("Running tests");
  });

  it("updates description field", () => {
    store.create("Test", "Original desc");
    const { changedFields } = store.update("1", { description: "Updated desc" });
    expect(changedFields).toContain("description");
    expect(store.get("1")!.description).toBe("Updated desc");
  });

  it("returns empty changedFields when updating non-existent task", () => {
    const { task, changedFields, warnings } = store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("clearCompleted cleans up dependency edges", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { addBlocks: ["2"] });
    store.update("1", { status: "completed" });

    store.clearCompleted();

    const t2 = store.get("2")!;
    expect(t2.blockedBy).toEqual([]);
  });

  it("handles multiple addBlocks in one call", () => {
    store.create("Blocker", "Desc");
    store.create("B1", "Desc");
    store.create("B2", "Desc");

    store.update("1", { addBlocks: ["2", "3"] });

    expect(store.get("1")!.blocks).toEqual(["2", "3"]);
    expect(store.get("2")!.blockedBy).toContain("1");
    expect(store.get("3")!.blockedBy).toContain("1");
  });

  it("allows independent tasks to run concurrently when distinct owners claim them in order", () => {
    store.create("First", "Desc");
    store.create("Second", "Desc");
    store.create("Third", "Desc");

    store.update("1", { status: "in_progress", owner: "worker-a" });
    store.update("2", { status: "in_progress", owner: "worker-b" });
    store.update("3", { status: "in_progress", owner: "worker-c" });

    expect(store.list("id").map(task => [task.id, task.status, task.owner])).toEqual([
      ["1", "in_progress", "worker-a"],
      ["2", "in_progress", "worker-b"],
      ["3", "in_progress", "worker-c"],
    ]);
  });

  it("limits parallel work to four tasks and leaves the next task pending", () => {
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) {
      store.update(String(i), { status: "in_progress", owner: `worker-${i}` });
    }
    const queuedBefore = structuredClone(store.get("5"));

    expect(() => store.update("5", {
      status: "in_progress",
      owner: "worker-5",
      subject: "Must remain queued",
    })).toThrow(/at most 4 tasks can be in progress/i);
    expect(store.get("5")).toEqual(queuedBefore);

    store.update("1", { status: "completed" });
    store.update("5", { status: "in_progress", owner: "worker-5" });
    expect(store.get("5")!.status).toBe("in_progress");
  });

  it("does not jump past earlier pending work", () => {
    store.create("Earlier", "Desc");
    store.create("Later", "Desc");
    const before = structuredClone(store.get("2"));

    expect(() => store.update("2", { status: "in_progress", owner: "team-lead" }))
      .toThrow(/cannot start before earlier task #1/i);
    expect(store.get("2")).toEqual(before);
  });

  it("allows a later prerequisite to start when earlier work depends on it", () => {
    store.create("Earlier dependent", "Desc");
    store.create("Later prerequisite", "Desc");
    store.update("1", { addBlockedBy: ["2"] });

    store.update("2", { status: "in_progress", owner: "team-lead" });

    expect(store.get("2")!.status).toBe("in_progress");
  });

  it("prevents one owner from abandoning open work to start another task", () => {
    store.create("Current", "Desc");
    store.create("Next", "Desc");
    store.update("1", { status: "in_progress", owner: "team-lead" });
    const before = structuredClone(store.get("2"));

    expect(() => store.update("2", { status: "in_progress", owner: "team-lead" }))
      .toThrow(/finish or undo task #1 before claiming task #2/i);
    expect(store.get("2")).toEqual(before);

    store.update("2", { status: "in_progress", owner: "reviewer" });
    expect(store.get("2")!.status).toBe("in_progress");
  });

  it("does not let an active owner abandon work by clearing or changing ownership", () => {
    store.create("Current", "Desc");
    store.update("1", { status: "in_progress", owner: "team-lead" });
    const before = structuredClone(store.get("1"));

    expect(() => store.update("1", { owner: "" }))
      .toThrow(/finish or undo task #1 before changing its owner/i);
    expect(() => store.update("1", { owner: "reviewer" }))
      .toThrow(/finish or undo task #1 before changing its owner/i);
    expect(store.get("1")).toEqual(before);
  });

  it("allows an owner to move on after completing or deleting its current task", () => {
    store.create("First", "Desc");
    store.create("Second", "Desc");
    store.create("Third", "Desc");
    store.update("1", { status: "in_progress", owner: "team-lead" });
    store.update("1", { status: "completed" });
    store.update("2", { status: "in_progress", owner: "team-lead" });
    store.update("2", { status: "deleted" });

    store.update("3", { status: "in_progress", owner: "team-lead" });

    expect(store.get("3")!.status).toBe("in_progress");
  });

  it("requires all blockers while unrelated work remains independent", () => {
    store.create("Blocker A", "Desc");
    store.create("Blocker B", "Desc");
    store.create("Unrelated", "Desc");
    store.create("Dependent", "Desc");
    store.update("4", { addBlockedBy: ["1", "2"] });
    store.update("1", { status: "in_progress", owner: "blocker-a" });
    store.update("2", { status: "in_progress", owner: "blocker-b" });
    store.update("3", { status: "in_progress", owner: "unrelated" });

    expect(() => store.update("4", { status: "in_progress", owner: "dependent" })).toThrow(/#1, #2/);
    store.update("1", { status: "completed" });
    expect(() => store.update("4", { status: "in_progress", owner: "dependent" })).toThrow(/#2/);
    store.update("2", { status: "completed" });

    store.update("4", { status: "in_progress", owner: "dependent" });
    expect(store.get("3")!.status).toBe("in_progress");
    expect(store.get("4")!.status).toBe("in_progress");
  });

  it("validates status and new blockers together before mutating any field", () => {
    store.create("Blocker", "Desc");
    store.create("Dependent", "Desc", undefined, { original: true });
    const before = structuredClone(store.list("id"));

    expect(() => store.update("2", {
      status: "in_progress",
      owner: "worker",
      metadata: { original: null, attempted: true },
      addBlockedBy: ["1"],
    })).toThrow(/blocked by #1/i);
    expect(store.list("id")).toEqual(before);
  });

  it("reduces same-call blockers to immediate prerequisites", () => {
    store.create("Root", "Desc");
    store.create("Middle", "Desc");
    store.create("Dependent", "Desc");
    store.update("2", { addBlockedBy: ["1"] });

    store.update("3", { addBlockedBy: ["1", "2"] });

    expect(store.get("1")!.blocks).toEqual(["2"]);
    expect(store.get("2")!.blockedBy).toEqual(["1"]);
    expect(store.get("2")!.blocks).toEqual(["3"]);
    expect(store.get("3")!.blockedBy).toEqual(["2"]);
  });

  it("reduces existing redundant edges when a new path makes them transitive", () => {
    store.create("Root", "Desc");
    store.create("Middle", "Desc");
    store.create("Dependent", "Desc");
    store.update("3", { addBlockedBy: ["1", "2"] });
    expect(store.get("3")!.blockedBy).toEqual(["1", "2"]);

    store.update("2", { addBlockedBy: ["1"] });

    expect(store.get("1")!.blocks).toEqual(["2"]);
    expect(store.get("2")!.blocks).toEqual(["3"]);
    expect(store.get("3")!.blockedBy).toEqual(["2"]);
  });

  it("does not complete a task while any prerequisite is unfinished", () => {
    store.create("Blocker", "Desc");
    store.create("Dependent", "Desc");
    store.update("2", { addBlockedBy: ["1"] });

    expect(() => store.update("2", { status: "completed" })).toThrow(/cannot complete; blocked by #1/i);
    expect(store.get("2")!.status).toBe("pending");

    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    expect(store.get("2")!.status).toBe("completed");
  });

  it("rejects unfinished blockers added to active or completed tasks", () => {
    store.create("Blocker", "Desc");
    store.create("Active", "Desc");
    store.create("Completed", "Desc");
    store.update("1", { status: "in_progress", owner: "blocker" });
    store.update("2", { status: "in_progress", owner: "active" });
    store.update("3", { status: "completed" });
    const before = structuredClone(store.list("id"));

    expect(() => store.update("2", { addBlockedBy: ["1"] })).toThrow(/unfinished blocker #1/i);
    expect(store.list("id")).toEqual(before);
    expect(() => store.update("1", { addBlocks: ["3"] })).toThrow(/unfinished blocker #1/i);
    expect(store.list("id")).toEqual(before);
  });

  it("rejects reopening a completed blocker with active or completed dependents", () => {
    store.create("Blocker", "Desc");
    store.create("Dependent", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { addBlockedBy: ["1"], status: "in_progress" });

    expect(() => store.update("1", { status: "pending" })).toThrow(/cannot reopen completed task #1/i);
    expect(store.get("1")!.status).toBe("completed");

    store.update("2", { status: "completed" });
    expect(() => store.update("1", { status: "in_progress" })).toThrow(/cannot reopen completed task #1/i);
    expect(store.get("1")!.status).toBe("completed");
  });

  it("still allows a standalone completed task to return to in_progress", () => {
    store.create("Standalone", "Desc");
    store.update("1", { status: "completed" });

    store.update("1", { status: "in_progress" });

    expect(store.get("1")!.status).toBe("in_progress");
  });

  it("clearCompleted returns 0 when no completed tasks", () => {
    store.create("Pending", "Desc");
    expect(store.clearCompleted()).toBe(0);
  });

  it("lists open tasks in queue order before completed tasks", () => {
    store.create("In-progress task", "Desc");
    store.create("Completed task", "Desc");
    store.create("Pending task", "Desc");
    store.create("Another pending", "Desc");

    store.update("1", { status: "in_progress" });
    store.update("2", { status: "completed" });

    const tasks = store.list();
    expect(tasks.map(t => t.id)).toEqual(["1", "3", "4", "2"]);
    expect(tasks.map(t => t.status)).toEqual(["in_progress", "pending", "pending", "completed"]);
  });
});

describe("TaskStore (file-backed)", () => {
  const testListId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tasksDir = join(homedir(), ".pi", "tasks");
  const filePath = join(tasksDir, `${testListId}.json`);

  afterEach(() => {
    // Clean up test file
    try { rmSync(filePath); } catch { /* */ }
    try { rmSync(filePath + ".lock"); } catch { /* */ }
    try { rmSync(filePath + ".tmp"); } catch { /* */ }
  });

  it("persists tasks to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Persistent task", "Should survive reload");

    // Create a new store instance pointing to same file
    const store2 = new TaskStore(testListId);
    const tasks = store2.list();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Persistent task");
  });

  it("persists in_progress updates to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Task", "Desc");
    store1.update("1", { status: "in_progress" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")!.status).toBe("in_progress");
  });

  it("persists completed tasks to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Done task", "Desc");
    store1.create("Pending task", "Desc");
    store1.update("1", { status: "completed" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")).toBeDefined();
    expect(store2.get("1")!.status).toBe("completed");
    expect(store2.get("2")).toBeDefined();
    expect(store2.list()).toHaveLength(2);
  });

  it("restores all tasks across instances", () => {
    const store1 = new TaskStore(testListId);
    store1.create("In progress", "Desc");
    store1.create("Pending", "Desc");
    store1.create("Done", "Desc");
    store1.update("1", { status: "in_progress" });
    store1.update("3", { status: "completed" });

    const store2 = new TaskStore(testListId);
    const tasks = store2.list();
    expect(tasks).toHaveLength(3);
    expect(tasks.map(t => t.id)).toContain("1");
    expect(tasks.map(t => t.id)).toContain("2");
    expect(tasks.map(t => t.id)).toContain("3");
  });

  it("persists ID counter across instances", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Task 1", "Desc");
    store1.create("Task 2", "Desc");

    const store2 = new TaskStore(testListId);
    const t3 = store2.create("Task 3", "Desc");
    expect(t3.id).toBe("3");
  });

  it("persists positioned task order across instances", () => {
    const store1 = new TaskStore(testListId);
    store1.create("First", "Desc");
    const second = store1.create("Second", "Desc");
    store1.create("Inserted", "Desc", undefined, undefined, { type: "before", taskId: second.id });

    const store2 = new TaskStore(testListId);
    expect(store2.list().map(task => task.subject)).toEqual(["First", "Inserted", "Second"]);
  });

  it("normalizes a persisted valid graph with redundant reciprocal edges", () => {
    const original = new TaskStore(testListId);
    original.create("Root", "Desc");
    original.create("Middle", "Desc");
    original.create("Dependent", "Desc");
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const [root, middle, dependent] = raw.tasks;
    root.blocks = ["2", "3"];
    middle.blockedBy = ["1"];
    middle.blocks = ["3"];
    dependent.blockedBy = ["1", "2"];
    writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const loaded = new TaskStore(testListId);
    expect(loaded.get("1")!.blocks).toEqual(["2"]);
    expect(loaded.get("2")!.blocks).toEqual(["3"]);
    expect(loaded.get("3")!.blockedBy).toEqual(["2"]);

    loaded.update("3", { subject: "Dependent updated" });
    const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(persisted.tasks.find((task: any) => task.id === "1").blocks).toEqual(["2"]);
    expect(persisted.tasks.find((task: any) => task.id === "3").blockedBy).toEqual(["2"]);
  });
});

describe("TaskStore (absolute path)", () => {
  const absFilePath = join(tmpdir(), `pi-tasks-test-${Date.now()}.json`);

  afterEach(() => {
    try { rmSync(absFilePath); } catch { /* */ }
    try { rmSync(absFilePath + ".lock"); } catch { /* */ }
    try { rmSync(absFilePath + ".tmp"); } catch { /* */ }
  });

  it("accepts absolute path and persists tasks", () => {
    const store1 = new TaskStore(absFilePath);
    store1.create("Abs path task", "Desc");

    const store2 = new TaskStore(absFilePath);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].subject).toBe("Abs path task");
  });

  it("persists completed tasks when using absolute path", () => {
    const store1 = new TaskStore(absFilePath);
    store1.create("Pending", "Desc");
    store1.create("Completed", "Desc");
    store1.update("2", { status: "completed" });

    const raw = JSON.parse(readFileSync(absFilePath, "utf-8"));
    expect(raw.tasks).toHaveLength(2);
  });
});
