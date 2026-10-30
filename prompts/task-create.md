Create one task for authorized work. Prefer tasks_create_in_batch for a known multi-task plan. Skip task tracking for trivial commands or informational answers unless requested.

Supply subject and acceptance-based description; optional activeForm controls the spinner and metadata stores context. Tasks start pending. Use task_update to record dependencies, assign an owner, and start work.

Optional position is beginning, end (default), or before/after an open taskId. Positioning orders existing blockers first but does not create dependencies. task_append/prepend are convenient relative-insertion alternatives.

Default kind is task. Use group only for requested grouping or distinct deliverables needing children; groups are unowned summaries. parentId attaches an executable task to a root group, with no nested groups. Kind and parent are fixed at creation.

Follow the shared task contract and bulk-work guidance. Do not turn optional discoveries into active obligations; record them separately until authorized. Preserve unfinished requested work when adding requirements.
