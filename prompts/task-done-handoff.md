Task #{{taskId}} completed.
Queue state: {{state}}

{{context}}

Use this context for the next step:
- ready: Read nextTask and its parent acceptance criteria above. Start it with task_update using its ID, status in_progress and the completing owner's identity (assign your owner identity if none was set). Do not repeat task_list/task_get unless the context is stale or incomplete. The suggestion is not a reservation; task_update checks current readiness before work starts.
- waiting: The list is not finished. Respect the shown owners, prerequisites and queue order. Continue your active work if any; otherwise wait for its owner/report or explain the blocker. An empty group needs concrete children or explicit removal. Do not steal work, skip blockers or poll task_list.
- complete: All tracked tasks are completed. For a flat list, use tasks_done after verification. Retain hierarchical records until the user explicitly requests cleanup.

Do not execute work outside the user's authorization. Complete the next task with task_done only after its acceptance criteria and verification pass.
