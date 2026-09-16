The agent became idle with {{count}} unfinished tracked task(s). Continue the authorized work now.

Current queue snapshot (up to 20 entries):
{{tasks}}

Resume your active task or use task_list to identify the next ready task; use task_get when its acceptance criteria are missing. Respect task ownership, dependencies, and queue order. Do not take over another owner's work or mark anything completed without verification. An empty group still needs concrete children.

If external work is already running, task_wait may yield only for an existing same-session scheduler wake or a successful agentic_code_review_subscribe registration in this caller. For an external /code-review, register its exact session/run/target/head first, then pass reviewRunId to task_wait alone. A promised reviewer ping is not a registered handoff. Do not create unrelated schedules, subscriptions or dependencies to qualify. An ended wait needs reassessment, not automatic re-arming.

If a specific unanswered user question blocks further progress, ask it with ask_user when available. Otherwise, state the blocking question clearly. Do not merely end with a progress summary. Respect user cancellation and authorization boundaries; this continuation does not authorize new side effects.
