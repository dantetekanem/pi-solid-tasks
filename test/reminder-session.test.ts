import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import initExtension from "../src/index.js";

function reminderPositions(messages: any[]): number[] {
  return messages.flatMap((message, index) => {
    const content = typeof message.content === "string" ? message.content :
      message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    return content?.startsWith("<system-reminder>") ? [index] : [];
  });
}

function scriptedStream(steps: Array<{ tool?: string; args?: Record<string, unknown> }>, requests: any[][]) {
  let index = 0;
  return {
    stream: async (model: any, context: any) => {
      requests.push(structuredClone(context.messages));
      const step = steps[index];
      if (!step) throw new Error(`Unexpected model request ${index + 1}`);
      const callId = `call-${index++}`;
      const result = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: step.tool
          ? [
            { type: "thinking", thinking: "preserved", thinkingSignature: "opaque-offline-signature" },
            { type: "toolCall", id: callId, name: step.tool, arguments: step.args ?? {} },
          ]
          : [{ type: "text", text: "Done" }],
        stopReason: step.tool ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done" }; },
        result: async () => result,
      } as any;
    },
    count: () => index,
  };
}

it("persists a hidden reminder at its original position across tool requests and a session reload", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-tasks-reminder-"));
  const previousTasks = process.env.PI_TASKS;
  const previousTasksDir = process.env.PI_TASKS_DIR;
  const previousConfig = process.env.PI_TASKS_CONFIG;
  delete process.env.PI_TASKS;
  process.env.PI_TASKS_DIR = join(tempDir, "tasks");
  process.env.PI_TASKS_CONFIG = join(tempDir, "tasks-config.json");
  const sessions: Array<{ dispose(): void }> = [];

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(tempDir, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "fake-offline-test-key");
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    if (!model) throw new Error("Missing installed Anthropic model");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const createLoader = async () => {
      const loader = new DefaultResourceLoader({
        cwd: tempDir, agentDir: tempDir, settingsManager,
        extensionFactories: [initExtension, (pi) => {
          pi.registerTool({
            name: "noop", label: "noop", description: "Deterministic non-task tool",
            parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
          });
          pi.registerTool({
            name: "terminal", label: "terminal", description: "End the tool loop",
            parameters: Type.Object({}),
            async execute() { return { content: [{ type: "text", text: "done" }], details: {}, terminate: true }; },
          });
        }],
      });
      await loader.reload();
      return loader;
    };
    const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
    const options = { cwd: tempDir, agentDir: tempDir, modelRuntime, model, settingsManager,
      tools: ["task_create", "task_update", "noop", "terminal"], };
    const { session } = await createAgentSession({ ...options, resourceLoader: await createLoader(), sessionManager: manager });
    sessions.push(session);
    await session.bindExtensions({});

    const requests: any[][] = [];
    const first = scriptedStream([
      { tool: "task_create", args: { subject: "Open work", description: "Not yet done" } },
      ...Array.from({ length: 5 }, () => ({ tool: "noop" })),
      {},
      {},
    ], requests);
    session.agent.streamFunction = first.stream;
    await session.prompt("Start the open task");
    expect(first.count()).toBe(7);
    const insertedAt = reminderPositions(requests[5]);
    expect(insertedAt).toHaveLength(1);
    expect(reminderPositions(requests[6])).toEqual(insertedAt);
    const firstThinking = requests[5].find((message) => message.role === "assistant").content[0];
    expect(firstThinking).toMatchObject({ thinking: "preserved", thinkingSignature: "opaque-offline-signature" });
    expect(requests[6].find((message) => message.role === "assistant").content[0]).toEqual(firstThinking);

    const stored = manager.buildSessionContext().messages;
    const reminder = stored.filter((message) => message.role === "custom" && reminderPositions([message]).length > 0);
    expect(reminder).toHaveLength(1);
    expect(reminder[0]).toMatchObject({ display: false });
    expect(reminderPositions(stored)).toEqual(insertedAt);
    const toolResults = stored.filter((message) => message.role === "toolResult" && message.toolName === "noop");
    expect(toolResults).toHaveLength(5);
    expect(toolResults.every((message) => message.content[0]?.type === "text" && message.content[0].text === "ok")).toBe(true);

    await session.prompt("Another question about the same work");
    expect(first.count()).toBe(8);
    expect(reminderPositions(requests[7])).toEqual(insertedAt);
    const file = manager.getSessionFile();
    if (!file) throw new Error("Expected a persisted Pi session");
    session.dispose();

    const restoredManager = SessionManager.open(file);
    const { session: restored } = await createAgentSession({
      ...options, resourceLoader: await createLoader(), sessionManager: restoredManager,
    });
    sessions.push(restored);
    await restored.bindExtensions({});
    const restoredRequests: any[][] = [];
    const afterReload = scriptedStream([
      ...Array.from({ length: 5 }, () => ({ tool: "noop" })),
      {},
    ], restoredRequests);
    restored.agent.streamFunction = afterReload.stream;
    await restored.prompt("Continue after reload");
    expect(afterReload.count()).toBe(6);
    for (const request of restoredRequests) expect(reminderPositions(request)).toEqual(insertedAt);
    expect(restoredRequests[0].find((message) => message.role === "assistant").content[0]).toEqual(firstThinking);
    expect(restoredManager.buildSessionContext().messages.filter(
      (message) => message.role === "custom" && reminderPositions([message]).length > 0,
    )).toHaveLength(1);

    const terminalRequests: any[][] = [];
    const terminalRun = scriptedStream([
      { tool: "task_update", args: { taskId: "1", description: "Still open" } },
      ...Array.from({ length: 3 }, () => ({ tool: "noop" })),
      { tool: "terminal" },
    ], terminalRequests);
    restored.agent.streamFunction = terminalRun.stream;
    await restored.prompt("Reassess the task, then stop the tool loop");
    expect(terminalRun.count()).toBe(5);
    expect(terminalRequests).toHaveLength(5);
    const afterTerminal = restoredManager.buildSessionContext().messages;
    expect(afterTerminal.at(-1)).toMatchObject({ role: "toolResult", toolName: "terminal" });
    expect(afterTerminal.filter(
      (message) => message.role === "custom" && reminderPositions([message]).length > 0,
    )).toHaveLength(1);
  } finally {
    for (const session of sessions) session.dispose();
    if (previousTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = previousTasks;
    if (previousTasksDir === undefined) delete process.env.PI_TASKS_DIR;
    else process.env.PI_TASKS_DIR = previousTasksDir;
    if (previousConfig === undefined) delete process.env.PI_TASKS_CONFIG;
    else process.env.PI_TASKS_CONFIG = previousConfig;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
