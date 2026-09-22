Work on task #{{taskId}} next.

This task was manually inserted as a draft:
{{rawTask}}

Before doing the implementation:
1. Use task_get to read task #{{taskId}}.
2. Improve the task by using task_update to replace the [draft] subject and draft description with a clearer task and acceptance criteria.
3. If the draft contains or reveals repeated-item work, apply the inventory-first decomposition contract before changing any item.
4. Mark task #{{taskId}} in_progress, then complete the work.
5. Call task_done for task #{{taskId}} only when the work and verification are complete, then continue from the returned next-task context.
