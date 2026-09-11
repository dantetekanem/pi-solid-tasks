import { readFileSync } from "node:fs";

export function loadPrompt(name: string, values: Record<string, string | number> = {}): string {
  const template = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trimEnd();
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing prompt variable: ${key}`);
    return String(values[key]);
  });
}
