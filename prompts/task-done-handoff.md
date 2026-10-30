Task #{{taskId}} completed.
Queue state: {{state}}

{{context}}

- ready: Use nextTask directly and claim/start it with task_update. The suggestion is not a reservation; the tool rechecks readiness. Do not refetch unless stale.
- waiting: Respect unfinished owners and blockers. Continue eligible authorized work; otherwise preserve state and report the blocker or await the existing delegated result. Do not poll, invent a wake-up, or undo work just to empty the queue.
- complete: After verifying the overall outcome, call tasks_done unless the user requested retaining records.

No new permission is granted. Complete each task only when its acceptance criteria pass.
