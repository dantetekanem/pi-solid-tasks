import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPrompt } from "./prompts.js";
import type { TaskStore } from "./task-store.js";
import { registerTaskWait } from "./task-wait.js";

const CHILD_PROBE = "pi-extended-teams:child-agent-lifecycle-probe";
const QUESTION_TOOLS = new Set(["ask_user", "ask_user_batch"]);
const NUDGE_DELAY_MS = 5 * 60_000;
const MAX_NUDGES = 2;

export function registerTaskContinuation(
  pi: ExtensionAPI,
  getStore: () => TaskStore,
  onWaitChanged?: (taskId: string | undefined) => void,
): void {
  let armed = false;
  let settled = false;
  let uiPromptOpen = false;
  let stopReason: string | undefined;
  let runSignal: AbortSignal | undefined;
  let nudges = 0;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  const openQuestions = new Set<string>();
  const wait = registerTaskWait(pi, getStore, continueIfIdle, onWaitChanged);

  function clearNudgeTimer() {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = undefined;
  }

  function reset(_event: unknown, ctx: ExtensionContext) {
    clearNudgeTimer();
    nudges = 0;
    wait.clear(ctx);
    armed = settled = uiPromptOpen = false;
    stopReason = undefined;
    runSignal = undefined;
    openQuestions.clear();
  }

  function continueIfIdle(ctx: ExtensionContext, reminderDue = false) {
    if (!armed || !settled || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (!stopReason || runSignal?.aborted || stopReason === "aborted" || stopReason === "error") {
      armed = false;
      wait.clear(ctx);
      return;
    }
    if (uiPromptOpen || openQuestions.size > 0) return;
    if (wait.isWaiting(ctx)) return;
    // Reconciliation can synchronously submit a producer handoff and start another run.
    if (!armed || !settled || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const unfinished = getStore().list().filter(task => task.status !== "completed");
    if (!unfinished.length) {
      armed = false;
      return;
    }

    // Existing synchronous, session-scoped teams contract; reports own the wake-up.
    const sessionId = ctx.sessionManager.getSessionId();
    let delegated = false;
    pi.events.emit(CHILD_PROBE, {
      sessionId,
      respond(snapshot: { sessionId: string; running: number; queued: number }) {
        if (snapshot.sessionId === sessionId && (snapshot.running > 0 || snapshot.queued > 0)) delegated = true;
      },
    });
    if (delegated || nudges >= MAX_NUDGES) return;
    if (!reminderDue) {
      nudgeTimer ??= setTimeout(() => {
        nudgeTimer = undefined;
        continueIfIdle(ctx, true);
      }, NUDGE_DELAY_MS);
      nudgeTimer.unref();
      return;
    }

    // Consume before sending: automatic runs must not reset the reminder budget.
    armed = false;
    nudges++;
    const shown = unfinished.slice(0, 20);
    pi.sendMessage({
      customType: "tasks-continuation",
      content: loadPrompt("task-continuation", {
        count: unfinished.length,
        tasks: JSON.stringify(shown.map(({ id, kind, subject, status, owner, blockedBy }) => ({
          id, kind, subject: subject.slice(0, 160), status, owner, blockedBy,
        }))),
      }),
      display: false,
      details: { taskIds: shown.map(task => task.id) },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);
  pi.on("agent_start", (_event, ctx) => {
    clearNudgeTimer();
    wait.clear(ctx);
    armed = nudges < MAX_NUDGES;
    settled = false;
    stopReason = undefined;
    runSignal = undefined;
  });
  pi.on("input", (event, ctx) => {
    clearNudgeTimer();
    wait.clear(ctx);
    if (event.source === "interactive" || event.source === "rpc") {
      nudges = 0;
      armed = true;
    }
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") wait.clear(ctx);
  });
  pi.on("turn_start", (_event, ctx) => { runSignal = ctx.signal ?? runSignal; });
  pi.on("turn_end", (event, ctx) => {
    if (event.message.role === "assistant") stopReason = event.message.stopReason;
    runSignal = ctx.signal ?? runSignal;
  });
  pi.on("agent_settled", (_event, ctx) => {
    settled = true;
    continueIfIdle(ctx);
  });
  pi.on("ui_prompt_start", () => { uiPromptOpen = true; });
  pi.on("ui_prompt_end", (_event, ctx) => {
    uiPromptOpen = false;
    continueIfIdle(ctx);
  });
  pi.on("tool_execution_start", (event) => {
    if (QUESTION_TOOLS.has(event.toolName)) openQuestions.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (openQuestions.delete(event.toolCallId)) continueIfIdle(ctx);
  });
}
