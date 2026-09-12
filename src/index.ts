/**
 * pi-solid-tasks — A pi extension providing strict task tracking and coordination.
 *
 * Tools:
 *   task_create   — Create a structured task
 *   tasks_create_in_batch — Create an initial plan with optional group children
 *   task_list     — List all tasks with status
 *   task_get      — Get full task details
 *   task_update   — Update task fields, status, dependencies
 *   task_done     — Complete one task and return the next ready task
 *   tasks_done    — Clear the fully completed task list
 *   task_output   — Get output from a background task process
 *   task_stop     — Stop a running background task process
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { loadPrompt } from "./prompts.js";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
import { hasHierarchy, taskProgress, taskTree } from "./task-hierarchy.js";
import { MAX_PARALLEL_RUNNING_TASKS, TaskPositionError, TaskStore, TaskUpdateError } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const DRAFT_TASK_PREFIX = "[draft]";

function draftTaskSubject(rawTask: string): string {
  return rawTask.startsWith(DRAFT_TASK_PREFIX) ? rawTask : `${DRAFT_TASK_PREFIX} ${rawTask}`;
}

function draftTaskDescription(rawTask: string): string {
  return loadPrompt("draft-task-description", { rawTask });
}

function taskRootDir(): string {
  const override = process.env.PI_TASKS_DIR;
  if (override && isAbsolute(override)) return override;
  return join(homedir(), ".pi", "tasks");
}

function draftTaskKickoffPrompt(taskId: string, rawTask: string): string {
  return loadPrompt("draft-task-kickoff", { taskId, rawTask });
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["task_create", "tasks_create_in_batch", "task_list", "task_get", "task_update", "task_done", "tasks_done", "task_output", "task_stop"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

const TASK_COMPLETION_CONTRACT = loadPrompt("completion-contract", { maxParallelTasks: MAX_PARALLEL_RUNNING_TASKS });
const BULK_WORK_DECOMPOSITION_CONTRACT = loadPrompt("bulk-work-decomposition");
const SYSTEM_REMINDER = loadPrompt("system-reminder", {
  completionContract: TASK_COMPLETION_CONTRACT,
  bulkWorkDecomposition: BULK_WORK_DECOMPOSITION_CONTRACT,
});

export default function (pi: ExtensionAPI) {
  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";
  const globalTasksDir = taskRootDir();

  function safeTaskPathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") || "default";
  }

  function isInsideLocalPi(value: string): boolean {
    const localPiDir = resolve(process.cwd(), ".pi");
    const candidate = resolve(value);
    return candidate === localPiDir || candidate.startsWith(`${localPiDir}/`);
  }

  /** Resolve the task store path from env/config without ever writing into cwd/.pi. */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks && isAbsolute(piTasks)) {
      return isInsideLocalPi(piTasks) ? join(globalTasksDir, "env", `${safeTaskPathSegment(piTasks)}.json`) : piTasks;
    }
    if (piTasks?.startsWith(".")) return join(globalTasksDir, "env", `${safeTaskPathSegment(piTasks)}.json`);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(globalTasksDir, "sessions", safeTaskPathSegment(sessionId), "tasks.json");
    }
    if (taskScope === "session") return undefined; // no session ID yet, start in-memory
    return join(globalTasksDir, "projects", `${safeTaskPathSegment(process.cwd())}.json`);
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let store = new TaskStore(resolveStorePath());
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      if (!path) return;
      store = new TaskStore(path);
      widget.setStore(store);
    }
    storeUpgraded = true;
  }

  function prepareCommandStore(ctx: ExtensionCommandContext): boolean {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    if (taskScope === "session" && !piTasks && !storeUpgraded) {
      ctx.ui.notify("Unable to identify the current Pi session ID; task store not ready.", "error");
      return false;
    }
    return true;
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && !hasHierarchy(tasks) && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(cadence.currentTurn)) widget.update();
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Cheap-first: avoid store.list() disk I/O unless the cadence helper
    // says the call could matter (i.e. it's a task tool that resets state,
    // or it might queue the reminder).
    const isTaskTool = TASK_TOOL_NAMES.has(event.toolName);
    if (
      !isTaskTool &&
      cadence.currentTurn - cadence.lastTaskToolUseTurn < REMINDER_INTERVAL
    ) {
      return {};
    }
    if (!isTaskTool && cadence.reminderInjectedThisCycle) return {};

    const hasTasks = isTaskTool ? false : store.list().some(task => task.status !== "completed");
    evaluateToolResult(cadence, event.toolName, hasTasks, cadenceConfig);
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    if (!drainReminderForContext(cadence)) return {};

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: SYSTEM_REMINDER }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  // Grab UI context early — before_agent_start fires before any tool calls,
  // so persisted tasks show up immediately on session start.
  pi.on("before_agent_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
  });

  // Rebind to the active Pi session on startup, /new, /resume, /fork, and /reload.
  // Session-scoped task state must follow Pi's session ID, not the project cwd.
  pi.on("session_start", async (event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event.reason === "resume";

    // Reset session-scoped state so the store switches to the active session folder.
    storeUpgraded = false;
    persistedTasksShown = false;
    resetCadenceState(cadence);
    autoClear.reset();

    // Memory mode has no file-backed store to switch — clear explicitly on /new.
    if (event.reason === "new" && taskScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(isResume);
  });

  // Keep the task UI bound to the latest tool context.
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: task_create
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_create",
    label: "task_create",
    description: loadPrompt("task-create", { bulkWorkDecomposition: BULK_WORK_DECOMPOSITION_CONTRACT }),
    promptGuidelines: [
      TASK_COMPLETION_CONTRACT,
      BULK_WORK_DECOMPOSITION_CONTRACT,
      ...loadPrompt("task-guidelines").split(/\n\n+/),
    ],
    parameters: Type.Object({
      kind: Type.Optional(Type.Unsafe<"task" | "group">({ type: "string", enum: ["task", "group"], description: "Executable task (default), or a grouping project/issue" })),
      parentId: Type.Optional(Type.String({ description: "Root group ID to contain this executable subtask (one level only)" })),
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in the spinner when in_progress (e.g., 'Running tests')" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
      position: Type.Optional(Type.Union([
        Type.Object({ type: Type.Literal("beginning") }),
        Type.Object({ type: Type.Literal("end") }),
        Type.Object({
          type: Type.Literal("before"),
          taskId: Type.String({ description: "ID of the open task to create this task before" }),
        }),
        Type.Object({
          type: Type.Literal("after"),
          taskId: Type.String({ description: "ID of the open task to create this task after" }),
        }),
      ], { description: "Where to place the task among open tasks. Defaults to end." })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const meta = params.metadata ?? {};
      try {
        const task = store.create(
          params.subject,
          params.description,
          params.activeForm,
          Object.keys(meta).length > 0 ? meta : undefined,
          params.position,
          { kind: params.kind, parentId: params.parentId },
        );
        autoClear.resetBatchCountdown();
        widget.update();
        return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
      } catch (error) {
        if (error instanceof TaskPositionError || error instanceof TaskUpdateError) return Promise.resolve(textResult(error.message));
        throw error;
      }
    },
  });

  const batchLeafFields = {
    subject: Type.String({ description: "A brief title for the task" }),
    description: Type.String({ description: "Requirements and acceptance criteria" }),
    activeForm: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
  };
  pi.registerTool({
    name: "tasks_create_in_batch",
    label: "tasks_create_in_batch",
    description: loadPrompt("tasks-create-in-batch", { bulkWorkDecomposition: BULK_WORK_DECOMPOSITION_CONTRACT }),
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        ...batchLeafFields,
        kind: Type.Optional(Type.Unsafe<"task" | "group">({ type: "string", enum: ["task", "group"] })),
        parentId: Type.Optional(Type.String({ description: "Existing root group for an executable task" })),
        children: Type.Optional(Type.Array(Type.Object(batchLeafFields, { additionalProperties: false }))),
      }, { additionalProperties: false }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params) {
      const tasks = store.createInBatch(params.tasks);
      autoClear.resetBatchCountdown();
      widget.update();
      const text = taskTree(tasks).map(({ task, prefix }) =>
        `${prefix}#${task.id} [${task.status}] ${task.subject}${task.parentId ? ` (parent #${task.parentId})` : ""}\n${task.description}`
      ).join("\n");
      return { ...textResult(text), details: { tasks } };
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: task_list
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_list",
    label: "task_list",
    description: loadPrompt("task-list", { maxParallelTasks: MAX_PARALLEL_RUNNING_TASKS }),
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const treeTasks = hasHierarchy(tasks) ? [...tasks].sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id)) : tasks;
      const lines = taskTree(treeTasks).map(({ task, prefix }) => {
        let line = `${prefix}#${task.id} [${task.status}] ${task.subject}`;
        if (task.kind === "group") {
          const progress = taskProgress(tasks, task.id);
          line += ` [${progress.completed}/${progress.total} tasks · ${progress.percent}%]`;
        }

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      if (hasHierarchy(tasks)) {
        const queue = tasks.filter(task => task.kind !== "group" && task.status !== "completed");
        lines.push(`Execution queue: ${queue.map(task => `#${task.id}`).join(", ") || "complete"}`);
      }
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: task_get
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_get",
    label: "task_get",
    description: loadPrompt("task-get", { maxParallelTasks: MAX_PARALLEL_RUNNING_TASKS }),
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);
      if (task.parentId) lines.push(`Parent: #${task.parentId}`);
      if (task.kind === "group") {
        const tasks = store.list();
        const progress = taskProgress(tasks, task.id);
        lines.push(`Progress: ${progress.completed}/${progress.total} tasks · ${progress.percent}%`);
        lines.push(`Children: ${tasks.filter(child => child.parentId === task.id).map(child => `#${child.id}`).join(", ") || "none"}`);
        lines.push("Group status follows children; no owner or manual status updates.");
      }

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: task_update
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_update",
    label: "task_update",
    description: loadPrompt("task-update", { maxParallelTasks: MAX_PARALLEL_RUNNING_TASKS }),
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "Owner claiming the task; active ownership cannot be cleared or changed" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      let update: ReturnType<TaskStore["update"]>;
      try {
        update = store.update(taskId, fields);
      } catch (error) {
        if (error instanceof TaskUpdateError) return Promise.resolve(textResult(error.message));
        throw error;
      }
      const { task, changedFields, warnings } = update;

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") autoClear.trackCompletion(taskId, cadence.currentTurn);
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return Promise.resolve(textResult(msg));
    },
  });

  pi.registerTool({
    name: "task_done",
    label: "task_done",
    description: loadPrompt("task-done"),
    parameters: Type.Object({ taskId: Type.String({ description: "ID of the completed and verified task" }) }),
    async execute(_toolCallId, params) {
      const { task: completedTask } = store.update(params.taskId, { status: "completed" });
      if (!completedTask) throw new Error(`Task #${params.taskId} not found`);
      widget.setActiveTask(params.taskId, false);
      autoClear.trackCompletion(params.taskId, cadence.currentTurn);
      widget.update();
      const nextTask = store.nextReadyTask(completedTask.owner);
      const unfinished = store.list().filter(task => task.status !== "completed");
      const state = nextTask ? "ready" : unfinished.length ? "waiting" : "complete";
      const context = nextTask
        ? { owner: completedTask.owner, nextTask, parent: nextTask.parentId ? store.get(nextTask.parentId) : undefined }
        : { unfinished: unfinished.map(({ id, kind, subject, status, owner, blockedBy }) => ({ id, kind, subject, status, owner, blockedBy })) };
      return {
        ...textResult(loadPrompt("task-done-handoff", {
          taskId: completedTask.id, state, context: JSON.stringify(context, null, 2),
        })),
        details: { state, completedTask, nextTask },
      };
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: tasks_done
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "tasks_done",
    label: "tasks_done",
    description: loadPrompt("tasks-done"),
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) {
        return Promise.resolve(textResult("No tasks found"));
      }

      const unfinished = tasks.filter(task => task.status !== "completed");
      if (unfinished.length > 0) {
        return Promise.resolve(textResult(
          `Cannot finish task cleanup while unfinished tasks remain: ${unfinished.map(task => `#${task.id} [${task.status}]`).join(", ")}. Complete and verify them first.`
        ));
      }

      const count = store.clearCompleted();
      autoClear.reset();
      widget.update();
      return Promise.resolve(textResult(`Cleared ${count} completed ${count === 1 ? "task" : "tasks"}. No tasks found`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: task_output
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_output",
    label: "task_output",
    description: loadPrompt("task-output"),
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) throw new Error(`No background process for task ${task_id}`);

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: task_stop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_stop",
    label: "task_stop",
    description: loadPrompt("task-stop"),
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) throw new Error(`No running background process for task ${taskId}`);

      store.update(taskId, { status: "pending", metadata: { lastError: "stopped before completion" } });
      autoClear.resetBatchCountdown();
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully and returned to pending`);
    },
  });

  // ──────────────────────────────────────────────────
  // /add-task command
  // ──────────────────────────────────────────────────

  pi.registerCommand("add-task", {
    description: "Add a raw draft task and send it to the agent to refine and execute",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!prepareCommandStore(ctx)) return;
      const rawTask = args.trim();
      if (!rawTask) {
        ctx.ui.notify("Usage: /add-task <task>", "error");
        return;
      }

      autoClear.resetBatchCountdown();
      const task = store.create(draftTaskSubject(rawTask), draftTaskDescription(rawTask), undefined, {
        draft: true,
        source: "/add-task",
        originalDraft: rawTask,
      });
      widget.update();
      ctx.ui.notify(`Added draft task #${task.id}: ${task.subject}`, "info");

      const prompt = draftTaskKickoffPrompt(task.id, rawTask);
      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!prepareCommandStore(ctx)) return;
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
          "Create group",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task" || choice === "Create group") {
          await createTask(choice === "Create group" ? "group" : "task");
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          const cleared = store.clearCompleted();
          ui.notify(`Cleared ${cleared} records. Completed subtasks of open projects are retained.`, "info");
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const treeTasks = hasHierarchy(tasks) ? [...tasks].sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id)) : tasks;
        const choices = taskTree(treeTasks).map(({ task, prefix }) => {
          const progress = task.kind === "group" ? taskProgress(tasks, task.id) : undefined;
          const suffix = progress ? ` · ${progress.completed}/${progress.total} tasks · ${progress.percent}%` : "";
          return `${prefix}${statusIcon(task.status)} #${task.id} [${task.status}] ${task.subject}${suffix}`;
        });
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.kind === "group") {
          if (!task.parentId) actions.push("Add subtask");
        } else if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        } else if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const progress = task.kind === "group" ? taskProgress(store.list(), task.id) : undefined;
        const suffix = progress ? `\n${progress.completed}/${progress.total} tasks · ${progress.percent}%` : "";
        const title = `#${task.id} [${task.status}] ${task.subject}${suffix}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "Add subtask") {
          return createTask("task", task.id);
        }
        if (action === "▸ Start (in_progress)") {
          try {
            store.update(taskId, { status: "in_progress" });
          } catch (error) {
            if (error instanceof TaskUpdateError) {
              ui.notify(error.message, "warning");
              return viewTaskDetail(taskId);
            }
            throw error;
          }
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          try {
            store.update(taskId, { status: "completed" });
          } catch (error) {
            if (error instanceof TaskUpdateError) {
              ui.notify(error.message, "warning");
              return viewTaskDetail(taskId);
            }
            throw error;
          }
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          try {
            store.update(taskId, { status: "deleted" });
          } catch (error) {
            if (!(error instanceof TaskUpdateError)) throw error;
            ui.notify(error.message, "warning");
            return viewTaskDetail(taskId);
          }
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (kind: "task" | "group" = "task", parentId?: string): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        try {
          store.create(subject, description, undefined, undefined, undefined, { kind, parentId });
        } catch (error) {
          if (!(error instanceof TaskUpdateError)) throw error;
          ui.notify(error.message, "warning");
          return mainMenu();
        }
        autoClear.resetBatchCountdown();
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
