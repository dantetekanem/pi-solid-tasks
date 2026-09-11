import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadPrompt } from "../src/prompts.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

describe("Markdown prompt loading", () => {
  it("loads relative to the module and substitutes values once, literally", () => {
    vi.mocked(readFileSync).mockReturnValue("Task {{id}}: {{input}}\n");
    expect(loadPrompt("example", { id: 4, input: "$& {{id}}" })).toBe("Task 4: $& {{id}}");
    expect(readFileSync).toHaveBeenLastCalledWith(new URL("../prompts/example.md", import.meta.url), "utf8");
  });

  it("fails clearly for an unbound template variable", () => {
    vi.mocked(readFileSync).mockReturnValue("Task {{missing}}");
    expect(() => loadPrompt("example")).toThrow("Missing prompt variable: missing");
  });
});
