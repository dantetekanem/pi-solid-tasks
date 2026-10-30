Update task details, ownership, status, or immediate dependencies. Prefer task_done for completion because it returns the next ready task.

## State and ownership

Tasks progress pending → in_progress → completed. Assign an owner and mark in_progress before work. Each owner may hold one active task; at most {{maxParallelTasks}} may run. Starting requires all blockers complete and no skipped earlier task unless it is active under another owner or depends on this task. Active ownership cannot be cleared or reassigned, and active tasks cannot return to pending.

If work is blocked, leave its state intact, record the blocker in metadata/description, preserve changes, and report the missing decision or access. Do not mark partial or failing work completed, undo it merely to clear the queue, or claim another task for the same owner. Independent owners may continue eligible work. There is no blocked status.

Delete records created in error or work the user cancelled only after accounting for its changes and side effects. Deletion is not rollback; never discard user work or infer permission to undo it.

## Fields

- status: in_progress, completed, or deleted.
- subject, description, activeForm: task wording and acceptance criteria.
- owner: claim before starting; active ownership is fixed.
- metadata: merge keys; null removes a key. Suitable for a blocker and required next signal.
- addBlockedBy / addBlocks: all-of dependencies; redundant transitive ancestors are removed.

Use the latest handoff details; call task_get only if missing or stale. Example: {"taskId":"3","owner":"lead","status":"in_progress"}. Record dependencies before starting with {"taskId":"3","addBlockedBy":["2"]}.
