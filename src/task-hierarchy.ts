import type { Task } from "./types.js";

export interface TaskProgress {
  completed: number;
  total: number;
  percent: number;
}

function isGroup(task: Task): boolean {
  return task.kind === "group";
}

export function taskProgress(tasks: Task[], taskId?: string): TaskProgress {
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }

  const included = taskId ? tasks.filter(task => task.id === taskId) : tasks;
  const leaves = new Set<string>();
  const visit = (task: Task): void => {
    if (!isGroup(task)) {
      leaves.add(task.id);
      return;
    }
    for (const child of children.get(task.id) ?? []) visit(child);
  };
  for (const task of included) visit(task);

  const executable = tasks.filter(task => leaves.has(task.id));
  const completed = executable.filter(task => task.status === "completed").length;
  const total = executable.length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

export function taskTree(tasks: Task[]): Array<{ task: Task; depth: number; prefix: string }> {
  const knownIds = new Set(tasks.map(task => task.id));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }

  const tree: Array<{ task: Task; depth: number; prefix: string }> = [];
  const visited = new Set<string>();
  const visit = (task: Task, depth: number, prefix = "", continuation = ""): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    tree.push({ task, depth, prefix });
    const siblings = children.get(task.id) ?? [];
    siblings.forEach((child, index) => {
      const last = index === siblings.length - 1;
      visit(child, depth + 1, continuation + (last ? "└─ " : "├─ "), continuation + (last ? "   " : "│  "));
    });
  };
  for (const task of tasks) {
    if (!task.parentId || !knownIds.has(task.parentId)) visit(task, 0);
  }
  for (const task of tasks) visit(task, 0);
  return tree;
}

export function hasHierarchy(tasks: Task[]): boolean {
  return tasks.some(task => task.kind === "group" || task.parentId !== undefined);
}
