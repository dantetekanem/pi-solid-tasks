import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DELIVERY_GRACE_MS = 30_000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const CONFIG_FIELDS = [
  "id",
  "createdAt",
  "action",
  "type",
  "schedule",
  "scope",
  "sessionFile",
  "cwd",
  "command",
  "prompt",
  "message",
  "triggerTurn",
  "timeoutMs",
  "wakeOn",
  "stopOn",
  "followUpPrompt",
  "successPrompt",
  "failurePrompt",
  "expiresAt",
  "maxRuns",
  "backoff",
  "executionRevision",
  "wakeOnChangeRevision",
];

function schedulerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scheduler state.");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}
function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// Read-only adapter for @jl1990/pi-scheduler 0.5.x state version 2. It has no subscription API.
// Never return other schedules, command output, or the raw state in tool results.
export function readScheduledWake(id: string, sessionFile: string) {
  const path =
    process.env.PI_SCHEDULER_STATE_FILE || join(homedir(), ".pi", "agent", "state", "scheduler", "tasks.json");
  let state: Record<string, unknown>;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid state file.");
    state = schedulerRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Scheduler state is missing, unreadable, malformed, or too large to verify.");
  }
  if (state.version !== 2 || !Array.isArray(state.tasks)) {
    throw new Error("Unsupported scheduler state; version 2 is required.");
  }
  const matches = state.tasks.filter((value) => value && typeof value === "object" && value.id === id);
  if (matches.length !== 1) throw new Error("An exact, unique scheduler task ID is required.");
  const task = schedulerRecord(matches[0]);
  if (task.scope !== "session" || task.sessionFile !== sessionFile) {
    throw new Error("Schedule must belong to this exact session, not cwd/global scope.");
  }
  if (!["once", "interval", "cron"].includes(String(task.type))) throw new Error("Unsupported schedule type.");
  const timeoutMs = task.action === "shell" ? task.timeoutMs : 0;
  const wakeCapable =
    (task.action === "prompt" && nonempty(task.prompt)) ||
    (task.action === "message" && task.triggerTurn !== false && nonempty(task.message)) ||
    (task.action === "shell" &&
      nonempty(task.command) &&
      ["success", "failure", "always"].includes(String(task.wakeOn)));
  if (!wakeCapable) {
    throw new Error(
      "Schedule must wake the agent; notify, silent, and change-only schedules cannot support task_wait.",
    );
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 600_000 ||
    (task.action === "shell" && timeoutMs === 0)
  ) {
    throw new Error("Shell waits require an explicit timeoutMs between 1 and 600000.");
  }
  const expiresAt = timestamp(task.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("Schedule requires a finite expiresIn deadline before task_wait.");
  const result = task.result === undefined ? {} : schedulerRecord(task.result);
  return {
    fingerprint: JSON.stringify(CONFIG_FIELDS.map((key) => task[key])),
    enabled: task.enabled === true,
    status: task.status,
    expiresAt,
    timeoutMs,
    nextRun: timestamp(task.nextRun),
    startedAt: timestamp(task.startedAt),
    runAttemptId: task.runAttemptId,
    runCount: task.runCount,
    maxRuns: task.maxRuns,
    attemptId: result.attemptId,
    wakeDisposition: result.wakeDisposition,
  };
}
export type ScheduledWake = ReturnType<typeof readScheduledWake>;

export function assertScheduleLive(schedule: ScheduledWake, now: number): void {
  if (!schedule.enabled || !["pending", "running"].includes(String(schedule.status))) {
    throw new Error("Schedule is disabled or no longer pending/running.");
  }
  if (!Number.isSafeInteger(schedule.runCount) || Number(schedule.runCount) < 0)
    throw new Error("Invalid scheduler run count.");
  if (
    schedule.maxRuns !== undefined &&
    (!Number.isSafeInteger(schedule.maxRuns) || Number(schedule.maxRuns) <= Number(schedule.runCount))
  ) {
    throw new Error("Schedule has invalid or exhausted maxRuns.");
  }
  if (schedule.status === "running") {
    if (
      !nonempty(schedule.runAttemptId) ||
      !Number.isFinite(schedule.startedAt) ||
      now > schedule.startedAt + schedule.timeoutMs + DELIVERY_GRACE_MS
    ) {
      throw new Error("Scheduler attempt is missing or overdue.");
    }
  } else {
    if (now >= schedule.expiresAt) throw new Error("Schedule expired without a wake-up.");
    if (
      !Number.isFinite(schedule.nextRun) ||
      schedule.nextRun >= schedule.expiresAt ||
      now > schedule.nextRun + DELIVERY_GRACE_MS
    ) {
      throw new Error("Schedule has no timely next run before expiry.");
    }
  }
}

export function assertScheduleAdmission(schedule: ScheduledWake, now: number): void {
  assertScheduleLive(schedule, now);
  if (schedule.expiresAt <= now || schedule.expiresAt > now + MAX_WAIT_MS) {
    throw new Error("Schedule must expire within the next 24 hours.");
  }
  if (
    ["pending", "delivered", "failed", "session-suppressed", "no-followup"].includes(String(schedule.wakeDisposition))
  ) {
    throw new Error("Schedule already attempted a wake-up; inspect that result instead of waiting on it again.");
  }
}
