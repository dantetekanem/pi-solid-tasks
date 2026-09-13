The agent became idle with {{count}} unfinished tracked task(s). Continue the authorized work now.

Current queue snapshot (up to 20 entries):
{{tasks}}

Resume your active task or use task_list to identify the next ready task; use task_get when its acceptance criteria are missing. Respect task ownership, dependencies, and queue order. Do not take over another owner's work or mark anything completed without verification. An empty group still needs concrete children.

If a specific unanswered user question blocks further progress, ask it with ask_user when available, or use task_wait with the blocked task ID and the actual question. Do not merely end with a progress summary. Respect user cancellation and authorization boundaries; this continuation does not authorize new side effects.
