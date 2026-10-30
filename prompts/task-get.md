Read one task by taskId when its full details are missing or stale. Do not refetch a current task_done handoff.

Returns subject, description, status, and immediate blocks/blockedBy relationships; redundant transitive prerequisites are removed. Use task_list for a broader queue overview. Readiness still requires satisfied dependencies, available ownership, and allowed queue order.
