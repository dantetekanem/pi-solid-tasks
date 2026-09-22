// ~/.pi/tasks/tasks-config.json — persists extension settings without touching project directories

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // legacy setting; the widget is always capped
  maxVisible?: number;                   // default and maximum: 5 task rows
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

function configPath(): string {
  const override = process.env.PI_TASKS_CONFIG;
  if (override && isAbsolute(override)) return override;
  return join(homedir(), ".pi", "tasks", "tasks-config.json");
}

export function loadTasksConfig(): TasksConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8"));
  } catch { return {}; }
}

export function saveTasksConfig(config: TasksConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
