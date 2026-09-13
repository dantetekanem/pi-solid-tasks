import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPrompt } from "./prompts.js";
import type { TaskStore } from "./task-store.js";

const CHILD_PROBE = "pi-extended-teams:child-agent-lifecycle-probe";
const QUESTION_TOOLS = new Set(["ask_user", "ask_user_batch"]);

export function registerTaskContinuation(pi: ExtensionAPI, getStore: () => TaskStore): void {
  let armed = false;
  let settled = false;
  let uiPromptOpen = false;
  let stopReason: string | undefined;
  let runSignal: AbortSignal | undefined;
  const openQuestions = new Set<string>();

  function reset() {
    armed = settled = uiPromptOpen = false;
    stopReason = undefined;
    runSignal = undefined;
    openQuestions.clear();
  }

  function continueIfIdle(ctx: ExtensionContext) {
    if (!armed || !settled || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (!stopReason || runSignal?.aborted || stopReason === "aborted" || stopReason === "error") {
      armed = false;
      return;
    }
    if (uiPromptOpen || openQuestions.size > 0) return;
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
    if (delegated) return;

    // Consume before sending: another settled notification cannot queue a duplicate.
    armed = false;
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
  pi.on("agent_start", () => {
    armed = true;
    settled = false;
    stopReason = undefined;
    runSignal = undefined;
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
