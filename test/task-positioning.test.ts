import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function storePath() {
  const directory = mkdtempSync(join(tmpdir(), "task-positioning-"));
  directories.push(directory);
  return join(directory, "tasks.json");
}

describe("dependency-aware relative creation", () => {
  it.each(["before", "after"] as const)("inserts %s a blocked anchor after ordering its prerequisites", (type) => {
    const store = new TaskStore();
    store.create("History", "Desc");
    store.update("1", { status: "completed" });
    store.create("Active", "Desc");
    store.update("2", { status: "in_progress", owner: "worker" });
    store.create("Dependent", "Desc");
    store.create("Unrelated", "Desc");
    store.create("Middle", "Desc");
    store.create("Root", "Desc");
    store.update("3", { addBlockedBy: ["5", "6", "1"] });
    store.update("5", { addBlockedBy: ["6"] });
    const before = structuredClone(store.list("id"));

    const inserted = store.create("Inserted", "Acceptance", "Inserting", { area: "core" }, { type, taskId: "3" });

    expect(store.list().map(task => task.id)).toEqual([
      "2", "6", "5", ...(type === "before" ? ["7", "3"] : ["3", "7"]), "4", "1",
    ]);
    expect(store.list().map(task => task.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(inserted).toMatchObject({
      status: "pending", owner: undefined, blocks: [], blockedBy: [],
      description: "Acceptance", activeForm: "Inserting", metadata: { area: "core" },
    });
    for (const original of before) {
      const { order: _order, ...fields } = original;
      expect(store.get(original.id)).toMatchObject(fields);
    }
    expect(store.nextReadyTask("lead")?.id).toBe("6");
    expect(() => store.update("3", { status: "in_progress", owner: "lead" })).toThrow(/blocked/);
  });

  it("sorts the latest shared state and persists insertion without losing another writer's work", () => {
    const path = storePath();
    const current = new TaskStore(path);
    const stale = new TaskStore(path);
    current.create("Dependent", "Desc");
    current.create("Blocker", "Desc");
    current.update("1", { addBlockedBy: ["2"] });

    stale.create("Inserted", "Desc", undefined, undefined, { type: "before", taskId: "1" });

    const reloaded = new TaskStore(path);
    expect(reloaded.list().map(task => task.id)).toEqual(["2", "3", "1"]);
    expect(reloaded.get("1")?.blockedBy).toEqual(["2"]);
    expect(reloaded.get("2")?.blocks).toEqual(["1"]);
    const before = readFileSync(path, "utf-8");
    expect(() => stale.create("Invalid", "Desc", undefined, undefined, { type: "after", taskId: "999" })).toThrow(/not found/);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(stale.create("Next", "Desc").id).toBe("4");
  });

  it.each(["cycle", "missing"])("rejects an unsortable %s graph without changing state or consuming IDs", (invalid) => {
    const path = storePath();
    const store = new TaskStore(path);
    store.create("First", "Desc");
    store.create("Second", "Desc");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    data.tasks[0].blockedBy = ["2"];
    data.tasks[1].blocks = ["1"];
    if (invalid === "cycle") data.tasks[0].blocks = ["2"];
    else data.tasks[1].blockedBy = ["999"];
    writeFileSync(path, JSON.stringify(data));
    const before = readFileSync(path, "utf-8");
    const tasks = structuredClone(store.list());

    expect(() => store.create("Inserted", "Desc", undefined, undefined, { type: "before", taskId: "1" })).toThrow(/dependenc/i);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(store.list()).toEqual(tasks);
    expect(store.create("Next", "Desc").id).toBe("3");
  });
});
