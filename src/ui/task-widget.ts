/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { hasHierarchy, taskProgress, taskTree } from "../task-hierarchy.js";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";
import type { Task } from "../types.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const MAX_VISIBLE_TASK_ROWS = 5;
const MAX_VISIBLE_SUBTASKS = 2;
const MAX_VISIBLE_COMPLETED_TASKS = 2;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  private waitingTaskId: string | undefined;
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  setWaitingTask(taskId: string | undefined) {
    this.waitingTaskId = taskId;
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allTasks = this.store.list("status");
    const hierarchical = hasHierarchy(allTasks);
    const tasks = allTasks.filter(task => task.kind !== "group");
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line.replace(/[\r\n]+/g, " "), w);

    if (allTasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const progress = taskProgress(allTasks);
    const statusText = hierarchical
      ? `${progress.completed}/${progress.total} tasks (${parts.join(", ") || "no tasks"}) - `
      : `${tasks.length} tasks (${parts.join(", ")}) - `;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const percentage = theme.fg("accent", `${progress.percent}%`).replace(
      /\x1b\[38;2;(\d+);(\d+);(\d+)m/g,
      (_match: string, red: string, green: string, blue: string) => {
        const whiteAlpha = 0.2;
        const channels = [red, green, blue].map(Number);
        const tintedRgb = channels.map(channel => Math.round(channel + (255 - channel) * whiteAlpha));
        return `\x1b[38;2;${tintedRgb.join(";")}m`;
      },
    );
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText) + percentage)];

    const limit = Math.min(this.config.maxVisible ?? MAX_VISIBLE_TASK_ROWS, MAX_VISIBLE_TASK_ROWS);
    const hiddenAt = this.config.hiddenAt ?? "bottom";
    const fromEdge = (items: Task[]) => hiddenAt === "top" ? [...items].reverse() : items;
    const byId = new Map(allTasks.map(task => [task.id, task]));
    const candidates = [
      ...fromEdge(inProgress),
      ...completed.slice(-MAX_VISIBLE_COMPLETED_TASKS).reverse(),
      ...fromEdge(pending),
      ...fromEdge(allTasks.filter(task => task.kind === "group")),
    ];
    const visibleIds = new Set<string>();
    let visibleSubtasks = 0;
    for (const task of candidates) {
      if (visibleIds.has(task.id)) continue;
      const parent = task.parentId ? byId.get(task.parentId) : undefined;
      if (parent?.status === "completed") continue;
      const rowCount = 1 + (parent && !visibleIds.has(parent.id) ? 1 : 0);
      if ((task.parentId && visibleSubtasks >= MAX_VISIBLE_SUBTASKS) || !(visibleIds.size + rowCount <= limit)) {
        if (parent && task.status === "in_progress" && visibleIds.size < limit) visibleIds.add(parent.id);
        continue;
      }
      if (parent) visibleIds.add(parent.id);
      visibleIds.add(task.id);
      if (task.parentId) visibleSubtasks++;
    }
    const tree = taskTree([...allTasks].sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id)));
    const visible = hierarchical
      ? tree.filter(({ task }) => visibleIds.has(task.id)).map(({ task }) => task)
      : tasks.filter(task => visibleIds.has(task.id));
    const prefixes = new Map(taskTree(visible).map(({ task, prefix }) => [task.id, prefix]));

    const hiddenTasks = tasks.filter(task => !visibleIds.has(task.id));
    const hiddenParts: string[] = [];
    const hiddenCompleted = hiddenTasks.filter(task => task.status === "completed").length;
    const hiddenInProgress = hiddenTasks.filter(task => task.status === "in_progress").length;
    const hiddenPending = hiddenTasks.filter(task => task.status === "pending").length;
    if (hiddenCompleted > 0) hiddenParts.push(`${hiddenCompleted} done`);
    if (hiddenInProgress > 0) hiddenParts.push(`${hiddenInProgress} in progress`);
    if (hiddenPending > 0) hiddenParts.push(`${hiddenPending} open`);
    const hiddenGroups = allTasks.filter(task => task.kind === "group" && !visibleIds.has(task.id)).length;
    if (hiddenGroups > 0) hiddenParts.push(`${hiddenGroups} groups`);
    const hiddenCount = hiddenTasks.length + hiddenGroups;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    … ${hiddenCount} hidden (${hiddenParts.join(", ")})`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isWaiting = task.id === this.waitingTaskId && task.status === "in_progress";
      const isActive = !isWaiting && this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (task.kind === "group") {
        const progress = taskProgress(allTasks, task.id);
        const summary = `${progress.completed}/${progress.total} · ${progress.percent}%`;
        text = task.status === "completed"
          ? `  ${icon} ${theme.fg("dim", `#${task.id} ${summary} ${task.subject}`)}`
          : `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.bold(summary)} ${task.subject}`;
      } else if (isActive) {
        const form = task.activeForm || task.subject;
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + "…")}${stats}`;
      } else if (task.status === "completed") {
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const waitLabel = isWaiting ? theme.fg("dim", "(on wait) ") : "";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${waitLabel}${task.subject}`;
      }

      lines.push(truncate("  " + (prefixes.get(task.id) ?? "") + text.slice(2) + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t =>
      t.id !== this.waitingTaskId && this.activeTaskIds.has(t.id) && t.status === "in_progress",
    );
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
