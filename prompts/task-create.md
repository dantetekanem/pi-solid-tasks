Create one executable task for the current session by default. Prefer tasks_create_in_batch for an initial flat plan with several known tasks. Use task_create for single follow-ups and custom positioning. Do not create a main group just to contain the entire request.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Use task_done for verified completion and add any new follow-up tasks discovered during implementation

## Repeated or Bulk Work

{{bulkWorkDecomposition}}

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **kind** (optional): Defaults to executable `task`; normally omit it. Use `group` only when the user requests grouping or distinct deliverables each need child tasks, not merely because work has several steps or agents. Groups derive status from children and are never assigned an owner or started manually.
- **parentId** (optional): Root group to contain this executable subtask. Exactly one subtask level is allowed: no nested groups or sub-subtasks. Parent and kind are fixed at creation. Dependencies apply only between executable tasks.
- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.
- **position** (optional): Place the new task at the beginning of open tasks, at the end of open tasks, or `before`/`after` a referenced open task. Omit it to use the end of open tasks. Relative insertion first pulls unfinished prerequisites ahead of their dependents, then inserts beside the anchor. This changes queue order, not dependencies. task_append and task_prepend provide this relative insertion directly for new executable tasks.

All tasks are created with status `pending`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use task_update to set up dependencies (blocks/blockedBy) if needed
- Check current task context to avoid duplicates; use task_list if the context is missing or stale
