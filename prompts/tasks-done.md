Finish task-list cleanup in one tool call after all work is complete. This is not task_done: task_done completes one task and returns the next task; tasks_done removes completed records.

Use this tool only after every tracked task is completed and verified. It removes all completed task records at once so task_list returns `No tasks found`.

The tool refuses to clear the list while any task is pending or in_progress. Use this final cleanup for flat and grouped lists before the final response. Retain completed records only when the user explicitly asks to keep them.
