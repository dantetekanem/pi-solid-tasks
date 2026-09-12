Complete one executable task and receive the next ready task in the same response. Use this instead of task_update for normal completion; tasks_done is whole-list cleanup.

Call only after the task's full acceptance criteria and verification pass. Never use completion to park partial work, skip unresolved failures or bypass prerequisites. Groups derive status from children and cannot be completed directly.

The response includes the next task's full details and parent context, selected for the completed task's owner using existing dependency, queue-order, ownership and running-task limits. The next task stays pending, and its existing owner is unchanged. Use task_update to start it; that call revalidates current state. Use the returned context directly instead of routinely calling task_list or task_get again.

If nothing is ready, the response reports unfinished work and owners, or confirms the list is complete. When the whole list is completed and verified, call tasks_done before the final response, including for grouped lists, unless the user explicitly asked to retain records. An empty group still counts as unfinished. Missing IDs and invalid completions return an error without completing a task. task_update completion remains available for compatibility, but does not return a handoff.
