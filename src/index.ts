/**
 * pi-tasks — A pi extension providing strict task tracking and coordination.
 *
 * Tools:
 *   task_create   — Create a structured task
 *   task_list     — List all tasks with status
 *   task_get      — Get full task details
 *   task_update   — Update task fields, status, dependencies
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
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
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
  return [
    "Manual draft task inserted with /add-task.",
    "",
    "Original draft:",
    rawTask,
    "",
    "Before doing the work, improve this draft into a clear task with concrete acceptance criteria. Update the task subject/description and remove the [draft] prefix, then execute it.",
  ].join("\n");
}

function taskRootDir(): string {
  const override = process.env.PI_TASKS_DIR;
  if (override && isAbsolute(override)) return override;
  return join(homedir(), ".pi", "tasks");
}

function draftTaskKickoffPrompt(taskId: string, rawTask: string): string {
  return [
    `Work on task #${taskId} next.`,
    "",
    "This task was manually inserted as a draft:",
    rawTask,
    "",
    "Before doing the implementation:",
    `1. Use task_get to read task #${taskId}.`,
    "2. Improve the task by using task_update to replace the [draft] subject and draft description with a clearer task and acceptance criteria.",
    "3. If the draft contains or reveals repeated-item work, apply the inventory-first decomposition contract before changing any item.",
    `4. Mark task #${taskId} in_progress, then complete the work.`,
    `5. Mark task #${taskId} completed only when the work is fully done.`,
  ].join("\n");
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["task_create", "task_list", "task_get", "task_update", "tasks_done", "task_output", "task_stop"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

const TASK_COMPLETION_CONTRACT = `Treat the active list managed with task_create, task_update, task_list, and tasks_done as a completion contract. Work through ready tasks in listed order: all declared blockedBy dependencies must be completed and no other owner may have claimed the task. A later task may start only when every earlier open task is actively in_progress under a different owner or depends on the later task; this prevents skipping while preserving deliberate parallel work. Never duplicate or take over an in_progress task owned by someone else. Before starting dependent work, record every prerequisite with addBlockedBy; only immediate prerequisites are retained because redundant transitive ancestors are removed. Each owner must finish or undo its current task before claiming another task: complete it with evidence, or undo every change and side effect, verify the rollback, and delete the task. Never park owned work in pending or in_progress and never jump to later work; different owners may continue ready independent tasks in parallel. At most ${MAX_PARALLEL_RUNNING_TASKS} tasks can be in progress at once; keep the next ready task pending in the queue. Before adding dependencies for discovered work, classify it against the current milestone's frozen acceptance criteria, threat model, and exercised slice. Only work required by those criteria, needed to prevent immediate data loss, privacy/security breach, or irreversibility, or needed to fix a failure in the currently exercised slice is a genuine prerequisite: create or update it before moving on and add only immediate prerequisites with addBlockedBy. Findings outside this scope are pending, nonblocking follow-ups: append them after current milestone work, do not move them ahead, add them as blockedBy prerequisites, or serialize unrelated hardening before a user-visible vertical slice. Never use this rule to skip genuinely blocking work. Mark a task completed only after its full acceptance criteria and verification are satisfied. After every task is completed and verified, delete the completed task records so task_list returns No tasks found.`;

const BULK_WORK_DECOMPOSITION_CONTRACT = `Use task_create and task_update to make repeated-item work explicit. When a request contains or a task discovers several independently actionable items that would make one task opaque—always when there are more than five—separate inventory from execution. If the concrete items are not known yet, make the current task an inventory task and discover the full list without changing the items. If the current task was a broad placeholder, first use task_update to rewrite its subject and acceptance criteria around inventory only. Then, before changing any discovered item, create the execution tasks and verify the expanded graph with task_list. Do not perform the discovered bulk execution inside the inventory task. Complete the inventory task only after both the inventory and follow-up graph exist. Prefer one task per item when an item can fail or be verified independently; otherwise create named batches of 4–5 items. Every batch task must list its exact items and focused check. Use a different batch size only when its description records a concrete cohesion, ordering, safety, or verification reason. If the concrete items are already known, create the item or batch tasks before execution instead of creating a redundant inventory task.`;

const SYSTEM_REMINDER = `<system-reminder>
There are unfinished tracked tasks. ${TASK_COMPLETION_CONTRACT} ${BULK_WORK_DECOMPOSITION_CONTRACT}
Make sure that you NEVER mention this reminder to the user.
</system-reminder>`;

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
      if (!isResume && tasks.every(t => t.status === "completed")) {
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

    const hasTasks = isTaskTool ? false : store.list().length > 0;
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
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## Repeated or Bulk Work

${BULK_WORK_DECOMPOSITION_CONTRACT}

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.
- **position** (optional): Place the new task at the beginning of open tasks, at the end of open tasks, or \`before\`/\`after\` a referenced open task. Omit it to use the end of open tasks.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use task_update to set up dependencies (blocks/blockedBy) if needed
- Check task_list first to avoid creating duplicate tasks`,
    promptGuidelines: [
      TASK_COMPLETION_CONTRACT,
      BULK_WORK_DECOMPOSITION_CONTRACT,
      "Use task_create to capture every new user requirement or discovered follow-up before moving on; append outside-scope follow-ups after existing work, and connect a follow-up with dependencies only when they are genuine prerequisites; never silently replace unfinished tasks.",
      "Use task_update to assign each parallel task a distinct owner and mark it in_progress before work begins. Each owner must finish or undo its current task before claiming another; never park owned work while moving ahead; keep pending follow-up tasks visible, and start them in listed order unless earlier work is active under another owner or depends on the later task.",
      "Use task_update addBlockedBy to record all declared dependencies before starting dependent work; the task remains pending until every blocker completes.",
      "Use task_list after each material completion and continue the earliest ready task you own; use tasks_done only after the whole list is verified complete.",
    ],
    parameters: Type.Object({
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
        );
        autoClear.resetBatchCountdown();
        widget.update();
        return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
      } catch (error) {
        if (error instanceof TaskPositionError) return Promise.resolve(textResult(error.message));
        throw error;
      }
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: task_list
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_list",
    label: "task_list",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see the ready set (status: 'pending', no owner, all blockedBy prerequisites completed, and no skipped earlier work)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- To claim up to ${MAX_PARALLEL_RUNNING_TASKS} ready independent tasks for parallel work by distinct owners
- To keep each owner on one task until it is finished or fully undone
- After completing a task, to find every newly unblocked task
- Start ready work in listed order; a later task can start only when earlier open work is actively owned by another owner or depends on it

## Output

Returns open tasks in their configured order, followed by completed tasks. Several tasks may be in_progress in parallel. Each summary includes:
- **id**: Stable task identifier (use with task_get, task_update)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Owner identifier if assigned, empty if available
- **blockedBy**: Open immediate prerequisite task IDs; all must be completed before the task is ready

Only immediate prerequisites are retained; redundant transitive blockers already implied by another prerequisite are removed.

Use task_get with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      const lines = tasks.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

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

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: task_get
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task_get",
    label: "task_get",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Immediate prerequisite tasks that must complete before this one can start

Redundant transitive blockers are omitted. If #3 depends on #2, a task blocked by both #2 and #3 retains only immediate prerequisite #3.

## Tips

- A pending task is ready when every blockedBy prerequisite is completed, no other owner has claimed it, and starting it would not skip earlier open work.
- Independent tasks may run in parallel when earlier work is active under a distinct owner.
- At most ${MAX_PARALLEL_RUNNING_TASKS} tasks can be in progress at once; keep the next ready task pending in the queue.
- Use task_list to see all tasks in summary form.`,
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
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Confirm all blockedBy prerequisites are completed; every declared dependency uses all-of semantics
- Assign a distinct owner and mark the task in_progress BEFORE beginning
- Multiple ready independent tasks may be in_progress in parallel under distinct owners
- At most ${MAX_PARALLEL_RUNNING_TASKS} tasks can be in progress at once; keep the next ready task pending in the queue
- Before starting later work, every earlier open task must be completed, actively owned by another owner, or depend on the later task
- After resolving, call task_list to find newly ready work

**Mark tasks as resolved:**
- A task cannot be completed while any immediate prerequisite is unfinished
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call task_list to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- An owner must finish or undo its current task before claiming another task
- If you cannot finish, do not park the task or jump ahead: undo every change and side effect, verify the rollback, then delete the task
- Deleting the task record without reversing its work is not an undo
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- To close unfinished work only after undoing every change and side effect and verifying the rollback
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Claim a task before work starts; an active owner cannot be cleared or changed
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark immediate prerequisites that must complete before this one can start; redundant transitive blockers are removed

## Status Workflow

Tasks are created as \`pending\`, then progress to \`in_progress\` and \`completed\`.

For agent-owned work, \`task_update\` does not return an active task to \`pending\`. After a verified undo, use \`deleted\` to permanently remove the task.

## Staleness

Make sure to read a task's latest state using \`task_get\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up one or more task dependencies (all must complete):
\`\`\`json
{"taskId": "3", "addBlockedBy": ["1", "2"]}
\`\`\``,
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

  // ──────────────────────────────────────────────────
  // Tool 5: tasks_done
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "tasks_done",
    label: "tasks_done",
    description: `Finish task-list cleanup in one tool call after all work is complete.

Use this tool only after every tracked task is completed and verified. It removes all completed task records at once so task_list returns \`No tasks found\`.

The tool refuses to clear the list while any task is pending or in_progress.`,
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
    description: `- Retrieves output from a running or completed background process
- Takes a task_id parameter identifying the task
- Returns the process output and status
- Use block=true (default) to wait for completion
- Use block=false for a non-blocking check`,
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
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
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
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
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

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
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

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

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
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
