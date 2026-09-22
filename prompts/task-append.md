Create a new executable task immediately after the existing open task identified by taskId. Use task_append for new work, not to move or update an existing task.

Before insertion, the open queue is sorted so unfinished prerequisites come before their dependents, including transitive blockers. Existing queue priority is preserved by pulling prerequisites forward. The new task is then inserted after its anchor; completed history stays at the end. IDs, ownership, statuses, and dependency relationships are unchanged. Position does not create a dependency; use task_update for genuine prerequisites.

Pass subject and description, with optional activeForm, metadata, and parentId. The new task starts pending and unowned. Omit parentId for a root task; it is not inherited from the anchor. Groups still display as a tree, separate from the execution queue.

Returns the created task and the resulting execution queue. Missing or completed anchors, invalid parents, and unsortable dependency graphs fail without creating a task or consuming an ID.
