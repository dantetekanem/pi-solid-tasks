Show the task list when a queue overview is needed or a completion handoff is stale. Flat output lists open tasks in execution order, then completed history. Grouped output also shows the explicit execution queue; do not infer order from the tree.

Each entry includes id, subject, status, owner, and open immediate blockedBy prerequisites. Groups summarize children and are not executable. A ready task is pending with no conflicting owner, all blockers completed, and no skipped earlier work unless that work is active under another owner or depends on it. At most {{maxParallelTasks}} tasks run, one per owner.

Use task_get only for missing details; task_done normally returns the next task without another list/get round trip. Blocked work stays visible and unfinished, not falsely completed or automatically rolled back.
