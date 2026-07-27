import { describe, expect, it, vi } from "vitest";

import initExtension from "../src/index.js";

function registerExtension() {
  const tools = new Map<string, any>();
  const emitted: string[] = [];
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: {
      on: vi.fn(() => vi.fn()),
      emit(channel: string) { emitted.push(channel); },
    },
  };

  initExtension(pi as any);
  return { tools, emitted };
}

describe("task execution removal", () => {
  it("does not register task_execute or initialize a subagent protocol", () => {
    const { tools, emitted } = registerExtension();

    expect(tools.has("task_execute")).toBe(false);
    expect(emitted.some(channel => channel.startsWith("subagents:"))).toBe(false);
    expect(tools.has("task_output")).toBe(true);
    expect(tools.has("task_stop")).toBe(true);
  });

  it("does not advertise agent execution on task_create", () => {
    const { tools } = registerExtension();
    const taskCreate = tools.get("task_create");

    expect(taskCreate.parameters.properties.agentType).toBeUndefined();
    expect(taskCreate.description).not.toContain("task_execute");
    expect(taskCreate.promptGuidelines.join("\n")).not.toContain("task_execute");
  });
});
