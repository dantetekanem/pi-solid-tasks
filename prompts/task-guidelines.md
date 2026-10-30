Use tasks_create_in_batch for an initial plan; task_create for one addition. task_append/prepend position new work without creating dependencies. Use task_update to assign an owner, start work, and record immediate addBlockedBy prerequisites.

Follow the shared task contract for scope, ordering, ownership, blockers, and completion. Keep descriptions acceptance-based. Task records do not authorize implementation or side effects.

Use task_wait only for already-started external work with a verified existing wake-up that meets its admission rules. It is not required for a truthful blocker report or a normal delegated-agent wait. Never create a schedule, subscription, or dependency just to qualify. User decisions are not external wake-ups.

Use task_done after verification; use its next-task handoff rather than routinely listing/refetching. tasks_done is cleanup only after the queue is complete.
