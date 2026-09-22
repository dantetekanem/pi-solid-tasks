import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPrompt } from "./prompts.js";
import { assertReviewAdmission, readReviewWake } from "./review-wait.js";
import { assertScheduleAdmission, assertScheduleLive, DELIVERY_GRACE_MS, readScheduledWake } from "./scheduler-wait.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";

function assertQueueWaitable(tasks: Task[], taskId: string): void {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.kind === "group" || task.status !== "in_progress" || !task.owner?.trim()) {
    throw new Error("task_wait requires an owned, in-progress executable task.");
  }
  if (task.blockedBy.some((id) => tasks.find((candidate) => candidate.id === id)?.status !== "completed")) {
    throw new Error("Resolve unfinished task dependencies before task_wait.");
  }
  const open = tasks.filter((candidate) => candidate.status !== "completed");
  const covered = new Set([taskId]);
  let previousSize = -1;
  while (previousSize !== covered.size) {
    previousSize = covered.size;
    for (const candidate of open) {
      if (candidate.kind === "group") {
        const children = open.filter((child) => child.parentId === candidate.id);
        if (children.length && children.every((child) => covered.has(child.id))) covered.add(candidate.id);
      } else if (candidate.status === "pending" && candidate.blockedBy.some((id) => covered.has(id))) {
        covered.add(candidate.id);
      }
    }
  }
  const other = open.filter((candidate) => !covered.has(candidate.id));
  if (other.length) {
    const taskIds = other.map((candidate) => `#${candidate.id}`).join(", ");
    throw new Error(`Cannot wait: unfinished work outside this dependency chain: ${taskIds}.`);
  }
}

export function registerTaskWait(
  pi: ExtensionAPI,
  getStore: () => TaskStore,
  onInvalidated: (ctx: ExtensionContext) => void,
  onWaitChanged?: (taskId: string | undefined) => void,
) {
  let waiting:
    | ({ taskId: string; sessionFile: string; queueSnapshot: string; deadline: number } & (
        | { schedulerTaskId: string; scheduleFingerprint: string; initialAttemptId: unknown; deliveryDeadline?: number }
        | { reviewRunId: string }
      ))
    | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function clear(ctx: ExtensionContext) {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!waiting) return;
    waiting = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("task-wait", undefined);
    onWaitChanged?.(undefined);
  }

  function requireScheduler() {
    if (!pi.getAllTools().some((tool) => tool.name === "schedule_task")) {
      throw new Error("task_wait requires the loaded pi-scheduler extension.");
    }
  }

  function isWaiting(ctx: ExtensionContext): boolean {
    if (!waiting) return false;
    if (ctx.signal?.aborted || ctx.sessionManager.getSessionFile() !== waiting.sessionFile) {
      clear(ctx);
      return false;
    }
    try {
      if (JSON.stringify(getStore().list()) !== waiting.queueSnapshot) {
        throw new Error("Task queue changed; reassess available work.");
      }
      if ("reviewRunId" in waiting) {
        const wake = readReviewWake(pi, waiting.sessionFile, waiting.reviewRunId);
        if (!waiting) return false; // The producer may synchronously start the next run.
        assertReviewAdmission(wake, Date.now());
        if (wake.deadline !== waiting.deadline)
          throw new Error("Review subscription deadline changed; reassess the handoff.");
        return true;
      }
      requireScheduler();
      const schedule = readScheduledWake(waiting.schedulerTaskId, waiting.sessionFile);
      if (schedule.fingerprint !== waiting.scheduleFingerprint) {
        throw new Error("Schedule configuration changed; reassess its wake-up contract.");
      }
      if (Date.now() >= waiting.deadline) {
        throw new Error("The bounded wait deadline elapsed without a resumed agent run.");
      }
      // Scheduler persists shell completion BEFORE submitting the prompt. A terminal record
      // is not proof that no wake is coming; allow that delivery to own the next run.
      if (
        schedule.attemptId !== waiting.initialAttemptId &&
        ["pending", "delivered"].includes(String(schedule.wakeDisposition))
      ) {
        waiting.deliveryDeadline ??= Date.now() + DELIVERY_GRACE_MS;
        if (Date.now() < waiting.deliveryDeadline) return true;
        throw new Error("Scheduler wake-up was not observed within the delivery grace period.");
      }
      if (["failed", "session-suppressed", "no-followup"].includes(String(schedule.wakeDisposition))) {
        throw new Error("Scheduler could not deliver its wake-up.");
      }
      assertScheduleLive(schedule, Date.now());
      return true;
    } catch (error) {
      if (!waiting) return false;
      const { taskId } = waiting;
      const source =
        "reviewRunId" in waiting ? { reviewRunId: waiting.reviewRunId } : { schedulerTaskId: waiting.schedulerTaskId };
      const wakeId = "reviewRunId" in waiting ? waiting.reviewRunId : waiting.schedulerTaskId;
      clear(ctx);
      const reason = error instanceof Error ? error.message : "Wait could not be verified.";
      pi.sendMessage(
        {
          customType: "task-wait-ended",
          display: true,
          content: loadPrompt("task-wait-ended", { taskId, wakeId, reason }),
          details: { taskId, ...source },
        },
        { triggerTurn: false },
      );
      return false;
    }
  }

  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (
      waiting &&
      "reviewRunId" in waiting &&
      message.role === "custom" &&
      message.customType === "agentic-code-review-subscription" &&
      (message.details as { runId?: unknown } | undefined)?.runId === waiting.reviewRunId
    ) {
      // Pi can drain this follow-up within the tool's existing run, without agent_start.
      clear(ctx);
    }
  });

  pi.registerTool({
    name: "task_wait",
    label: "task_wait",
    description: loadPrompt("task-wait"),
    parameters: Type.Object(
      {
        taskId: Type.String({
          minLength: 1,
          maxLength: 128,
          description: "Owned in-progress task waiting for external work",
        }),
        schedulerTaskId: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 128,
            description: "Exact existing same-session scheduler ID; supply this OR reviewRunId",
          }),
        ),
        reviewRunId: Type.Optional(
          Type.String({
            format: "uuid",
            description:
              "Exact run ID already registered with agentic_code_review_subscribe in this caller; not an arbitrary review",
          }),
        ),
        reason: Type.String({
          minLength: 1,
          maxLength: 1000,
          pattern: "\\S",
          description: "Concrete external blocker; why no authorized work can proceed",
        }),
        expectedSignal: Type.String({
          minLength: 1,
          maxLength: 1000,
          pattern: "\\S",
          description: "What the registered wake-up will establish and what to do then",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Cannot wait after cancellation.");
      if (waiting) throw new Error("A wait is already active; do not extend or replace it.");
      if (!params.reason.trim() || !params.expectedSignal.trim())
        throw new Error("A concrete reason and expected signal are required.");
      if (Boolean(params.schedulerTaskId) === Boolean(params.reviewRunId)) {
        throw new Error("Supply exactly one schedulerTaskId or subscribed reviewRunId.");
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) throw new Error("task_wait requires a persisted session for wake-up ownership.");
      if (ctx.hasPendingMessages()) throw new Error("A message is already pending; process it before task_wait.");
      const tasks = getStore().list();
      assertQueueWaitable(tasks, params.taskId);
      const common = { taskId: params.taskId, sessionFile, queueSnapshot: JSON.stringify(tasks) };
      if (params.reviewRunId) {
        const wake = readReviewWake(pi, sessionFile, params.reviewRunId);
        assertReviewAdmission(wake, Date.now());
        waiting = { ...common, reviewRunId: params.reviewRunId, deadline: wake.deadline };
      } else {
        requireScheduler();
        const schedule = readScheduledWake(params.schedulerTaskId!, sessionFile);
        assertScheduleAdmission(schedule, Date.now());
        waiting = {
          ...common,
          schedulerTaskId: params.schedulerTaskId!,
          scheduleFingerprint: schedule.fingerprint,
          deadline: schedule.expiresAt + schedule.timeoutMs + DELIVERY_GRACE_MS,
          initialAttemptId: schedule.attemptId,
        };
      }
      // Reconcile after enrollment: the wake source may finish between these checks.
      if (!isWaiting(ctx)) throw new Error("Wait changed during admission; inspect the task_wait-ended notice.");
      const wakeId = params.reviewRunId ?? params.schedulerTaskId;
      if (ctx.hasUI) {
        const deadline = new Date(waiting.deadline).toISOString();
        ctx.ui.setStatus("task-wait", `Waiting #${params.taskId} · ${wakeId} · until ${deadline}`);
      }
      timer = setInterval(() => {
        if (!isWaiting(ctx)) onInvalidated(ctx);
      }, 5000);
      timer.unref();
      onWaitChanged?.(params.taskId);
      return {
        content: [
          {
            type: "text",
            text: `Waiting on #${params.taskId}: ${params.reason}\nExpected signal: ${params.expectedSignal}\n${params.reviewRunId ? "Subscribed review" : "Scheduler"}: ${wakeId}. Task remains in progress; the next agent run clears this wait.`,
          },
        ],
        details: {
          taskId: params.taskId,
          ...(params.reviewRunId ? { reviewRunId: params.reviewRunId } : { schedulerTaskId: params.schedulerTaskId }),
          deadline: waiting.deadline,
        },
        terminate: true,
      };
    },
  });
  return { isWaiting, clear };
}
