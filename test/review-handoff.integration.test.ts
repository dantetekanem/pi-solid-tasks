import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { registerTaskContinuation } from "../src/task-continuation.js";
import { TaskStore } from "../src/task-store.js";

// Explicit opt-in: actual host/runner, deterministic model, temporary session/artifacts only.
const producerCheckout = process.env.PI_AUTO_REVIEW_CHECKOUT;
describe.skipIf(!producerCheckout)("installed Pi session / review producer handoff", () => {
  it.each([false, true])("consumes the result once (delivery before initial settlement: %s)", async (earlyDelivery) => {
    const piEntry = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const piRequire = createRequire(piEntry);
    const { Agent } = await import(
      pathToFileURL(join(dirname(piRequire.resolve("@earendil-works/pi-agent-core/package.json")), "dist/index.js"))
        .href
    );
    const { AgentSession, SessionManager, SettingsManager, createEventBus } = await import(pathToFileURL(piEntry).href);
    const { createExtensionRuntime, loadExtensionFromFactory } = await import(
      pathToFileURL(join(dirname(piEntry), "core/extensions/loader.js")).href
    );
    const { registerReviewSubscription } = await import(`${producerCheckout}/src/review-subscription.ts`);
    const root = mkdtempSync(join(tmpdir(), "review-handoff-integration-"));
    const reviewSessionId = "external-review";
    const runId = "6289edd8-24e4-4500-9a08-f72e7af1c2df";
    const directory = join(root, reviewSessionId);
    mkdirSync(directory);
    const review = {
      schemaVersion: 1,
      sessionId: reviewSessionId,
      runId,
      status: "prepared",
      preflight: { target: "https://github.com/o/r/pull/7", head: "abcdef123456" },
    };
    const save = (suffix: string, value: unknown) => {
      const path = join(directory, `${runId}.${suffix}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(value));
      renameSync(`${path}.tmp`, path);
    };
    save("review", review);
    const complete = () => {
      const completedAt = new Date().toISOString();
      save("review", { ...review, status: "complete", completedAt });
      save("complete", { sessionId: reviewSessionId, runId, status: "complete", completedAt, summary: "Finished" });
    };
    const events = createEventBus();
    const runtime = createExtensionRuntime();
    const store = new TaskStore();
    store.create("Reconcile subscribed review", "Inspect the completed handoff");
    store.update("1", { owner: "lead", status: "in_progress" });
    const received: any[] = [];
    const errors: any[] = [];
    const settlements: boolean[] = [];
    let calls = 0;
    let retainedSignal: AbortSignal | undefined;
    let finished!: () => void;
    const handoffSettled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const extension = await loadExtensionFromFactory(
      (pi: any) => {
        registerReviewSubscription(pi, root);
        registerTaskContinuation(pi, () => store);
        pi.on("message_start", (event: any) => {
          if (event.message.role === "custom") received.push(event.message);
        });
        pi.on("tool_result", (event: any, ctx: any) => {
          if (event.toolName !== "task_wait") return;
          retainedSignal = ctx.signal;
          if (earlyDelivery) {
            complete();
            events.emit("agentic-code-review:wait-probe", {
              version: 1,
              sessionFile: ctx.sessionManager.getSessionFile(),
              runId,
              reply() {},
            });
          }
        });
        pi.on("agent_settled", (_event: any, ctx: any) => {
          settlements.push(ctx.isIdle());
          if (calls >= 3) finished();
        });
      },
      root,
      events,
      runtime,
    );
    // A supplied ResourceLoader avoids loading any personal extensions, settings or context.
    const resourceLoader = {
      getExtensions: () => ({ extensions: [extension], runtime, errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Use the test's deterministic responses.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
    };
    const model = {
      id: "test",
      name: "Test",
      provider: "test",
      api: "anthropic-messages",
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 8000,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const plannedCalls = [
      {
        type: "toolCall",
        id: "subscribe",
        name: "agentic_code_review_subscribe",
        arguments: {
          reviewSessionId,
          runId,
          expectedTarget: review.preflight.target,
          expectedHead: review.preflight.head,
        },
      },
      {
        type: "toolCall",
        id: "wait",
        name: "task_wait",
        arguments: {
          taskId: "1",
          reviewRunId: runId,
          reason: "The subscribed review is running",
          expectedSignal: "Read its completed report",
        },
      },
    ];
    const agent = new Agent({
      initialState: { model },
      streamFn: () => {
        const call = plannedCalls[calls++];
        if (!call) store.update("1", { status: "completed" });
        const message = {
          role: "assistant",
          content: call ? [call] : [{ type: "text", text: "Handoff consumed" }],
          stopReason: call ? "toolUse" : "stop",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", message };
          },
          result: async () => message,
        };
      },
    });
    const extensionRunnerRef: { current?: any } = {};
    const session = new AgentSession({
      agent,
      cwd: root,
      resourceLoader,
      extensionRunnerRef,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      baseToolsOverride: {},
      modelRuntime: {
        getModel: () => model,
        hasConfiguredAuth: () => true,
        getAuth: async () => ({ auth: { apiKey: "local-test-only" }, env: {} }),
      },
    });
    try {
      await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
      await session.prompt("Subscribe and wait", { expandPromptTemplates: false });
      expect(agent.signal).toBeUndefined();
      expect(retainedSignal?.aborted).toBe(false);
      if (!earlyDelivery) {
        expect(calls).toBe(2); // Real tool wrapping preserved terminate:true.
        expect(received).toHaveLength(0);
        await session.abort();
        expect(retainedSignal?.aborted).toBe(false);
        complete();
      }
      await Promise.race([
        handoffSettled,
        new Promise((_, reject) => setTimeout(() => reject(new Error("No host handoff settlement")), 1500).unref()),
      ]);
      await session.waitForIdle();
      expect(errors).toEqual([]);
      expect(calls).toBe(3);
      expect(settlements).toEqual(earlyDelivery ? [true] : [true, true]);
      expect(received).toHaveLength(1);
      expect(received[0].customType).toBe("agentic-code-review-subscription");
      expect(received[0].content).toContain(`Subscribed review ${runId} completed.`);
      expect(store.get("1")?.status).toBe("completed");
    } finally {
      await extensionRunnerRef.current?.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
      events.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
