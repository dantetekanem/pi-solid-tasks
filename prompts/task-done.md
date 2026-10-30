Complete one verified executable task and return the next ready task with full context. Groups derive completion from children; unfinished blockers prevent completion.

Pass taskId only after its entire acceptance criteria pass. A blocker report is not completion: retain partial work and task state rather than marking it done to end the turn.

Use the returned next-task details directly. It remains pending and is not reserved; start it with task_update, which rechecks ownership and queue rules. Fetch list/get only when the handoff is stale or incomplete. A waiting result names unfinished work; respect its owners and blockers. Once all work is verified complete, call tasks_done for cleanup unless the user requested retaining records. Missing IDs or invalid completions leave state unchanged.
