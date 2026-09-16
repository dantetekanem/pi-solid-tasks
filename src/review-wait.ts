import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReviewWake = { deadline: number; status: "waiting" | "delivered" | "ended" };

/** Probe a producer-owned subscription; never infer a handoff from agent prose. */
export function readReviewWake(pi: ExtensionAPI, sessionFile: string, runId: string): ReviewWake {
  const responses: unknown[] = [];
  let collecting = true;
  try {
    pi.events.emit("agentic-code-review:wait-probe", {
      version: 1,
      sessionFile,
      runId,
      reply: (response: unknown) => {
        if (collecting) responses.push(response);
      },
    });
  } finally {
    collecting = false;
  }
  const value = responses[0] as Record<string, unknown> | undefined;
  if (
    responses.length !== 1 ||
    !value ||
    value.version !== 1 ||
    value.runId !== runId ||
    value.sessionFile !== sessionFile
  ) {
    throw new Error("No unique caller-owned review subscription. Use agentic_code_review_subscribe before task_wait.");
  }
  if (
    !["waiting", "delivered", "ended"].includes(String(value.status)) ||
    typeof value.deadline !== "number" ||
    !Number.isFinite(value.deadline)
  ) {
    throw new Error("The review subscription returned an invalid wake-up contract.");
  }
  return { deadline: value.deadline, status: value.status as ReviewWake["status"] };
}

export function assertReviewAdmission(wake: ReviewWake, now: number): void {
  if (wake.status !== "waiting" || wake.deadline <= now || wake.deadline > now + 3_600_000) {
    throw new Error("The review subscription must be waiting with an unexpired deadline within one hour.");
  }
}
