Use tasks_create_in_batch for a known initial plan and task_create for individual follow-ups. Capture every new user requirement or discovered follow-up before moving on; append outside-scope follow-ups after existing work, and connect a follow-up with dependencies only when they are genuine prerequisites; never silently replace unfinished tasks.

Use task_update to assign each parallel task a distinct owner and mark it in_progress before work begins. Each owner must finish or undo its current task before claiming another; never park owned work while moving ahead; keep pending follow-up tasks visible, and start them in listed order unless earlier work is active under another owner or depends on the later task.

Use task_update addBlockedBy to record all declared dependencies before starting dependent work; the task remains pending until every blocker completes.

Use task_done after each verified completion and continue from its next-task context. Use task_list/task_get only when that context is missing or stale, or a broader queue overview is needed. Once the whole list is completed and verified, call tasks_done before the final response, including for grouped lists. Retain records only when the user explicitly asks to keep them.
