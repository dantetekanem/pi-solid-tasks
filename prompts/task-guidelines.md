Use task_create to capture every new user requirement or discovered follow-up before moving on; append outside-scope follow-ups after existing work, and connect a follow-up with dependencies only when they are genuine prerequisites; never silently replace unfinished tasks.

Use task_update to assign each parallel task a distinct owner and mark it in_progress before work begins. Each owner must finish or undo its current task before claiming another; never park owned work while moving ahead; keep pending follow-up tasks visible, and start them in listed order unless earlier work is active under another owner or depends on the later task.

Use task_update addBlockedBy to record all declared dependencies before starting dependent work; the task remains pending until every blocker completes.

Use task_list after each material completion and continue the earliest ready task you own; use tasks_done only after the whole list is verified complete. For hierarchical projects, clear only when the user explicitly requests it.
