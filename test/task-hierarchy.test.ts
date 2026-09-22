import { describe, expect, it } from "vitest";
import { hasHierarchy, taskProgress, taskTree } from "../src/task-hierarchy.js";
import type { Task } from "../src/types.js";

function task(id: string, status: Task["status"], options: Partial<Task> = {}): Task {
  return {
    id, subject: id, description: "", status, order: Number(id), metadata: {}, blocks: [], blockedBy: [],
    createdAt: 0, updatedAt: 0, ...options,
  };
}

describe("task hierarchy", () => {
  it("counts executable descendants exactly once and excludes empty groups", () => {
    const tasks = [
      task("1", "pending", { kind: "group" }),
      task("2", "pending", { kind: "group", parentId: "1" }),
      task("3", "completed", { parentId: "2" }),
      task("4", "pending", { parentId: "1" }),
      task("5", "pending", { kind: "group" }),
    ];

    expect(taskProgress(tasks, "1")).toEqual({ completed: 1, total: 2, percent: 50 });
    expect(taskProgress(tasks)).toEqual({ completed: 1, total: 2, percent: 50 });
    expect(taskProgress(tasks, "5")).toEqual({ completed: 0, total: 0, percent: 0 });
  });

  it("connects direct children and ends each parent's branch", () => {
    const tasks = [
      task("1", "pending", { kind: "group" }),
      task("2", "pending", { parentId: "1" }),
      task("3", "completed", { parentId: "1" }),
      task("4", "pending", { kind: "group" }),
    ];
    expect(taskTree(tasks).map(row => row.prefix)).toEqual(["", "├─ ", "└─ ", ""]);
  });

  it("returns a depth-first tree in sibling input order", () => {
    const tasks = [
      task("1", "pending", { kind: "group" }),
      task("2", "pending", { parentId: "1" }),
      task("3", "pending", { kind: "group", parentId: "1" }),
      task("4", "pending", { parentId: "3" }),
      task("5", "pending"),
    ];

    expect(taskTree(tasks).map(({ task, depth }) => [task.id, depth])).toEqual([
      ["1", 0], ["2", 1], ["3", 1], ["4", 2], ["5", 0],
    ]);
    expect(hasHierarchy(tasks)).toBe(true);
    expect(hasHierarchy([task("6", "pending")])).toBe(false);
  });
});
