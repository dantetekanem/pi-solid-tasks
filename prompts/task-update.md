Use this tool to start a task, assign an owner, edit details or dependencies, or delete undone work. Prefer task_done for completion: it returns the next ready task in the same response. Updating status to completed here remains supported but does not provide that handoff.

## When to Use This Tool

**Before starting work on a task:**
- Confirm all blockedBy prerequisites are completed; every declared dependency uses all-of semantics
- Assign a distinct owner and mark the task in_progress BEFORE beginning
- Multiple ready independent tasks may be in_progress in parallel under distinct owners
- At most {{maxParallelTasks}} tasks can be in progress at once; keep the next ready task pending in the queue
- Before starting later work, every earlier open task must be completed, actively owned by another owner, or depend on the later task

**Complete verified tasks with task_done:**
- A task cannot be completed while any immediate prerequisite is unfinished
- When you have completed the work described in a task
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- Continue from task_done's returned next-task context; request a new list only if that context is missing or stale

- ONLY mark a task as completed when you have FULLY accomplished it
- An owner must finish or undo its current task before claiming another task
- If you cannot finish, do not park the task or jump ahead: undo every change and side effect, verify the rollback, then delete the task
- Deleting the task record without reversing its work is not an undo
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- To close unfinished work only after undoing every change and side effect and verifying the rollback
- Setting status to `deleted` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Claim a task before work starts; an active owner cannot be cleared or changed
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark immediate prerequisites that must complete before this one can start; redundant transitive blockers are removed

## Status Workflow

Tasks are created as `pending`, then progress to `in_progress` and `completed`.

For agent-owned work, `task_update` does not return an active task to `pending`. After a verified undo, use `deleted` to permanently remove the task.

## Staleness

Use the latest task details already returned by task_done or another task tool. Call task_get only when those details are missing or stale; do not add a routine read before every update.

## Examples

Mark task as in progress when starting work:
```json
{"taskId": "1", "status": "in_progress"}
```

Complete verified work with the separate task_done tool:
```json
{"taskId": "1"}
```

Delete a task:
```json
{"taskId": "1", "status": "deleted"}
```

Claim a task by setting owner:
```json
{"taskId": "1", "owner": "my-name"}
```

Set up one or more task dependencies (all must complete):
```json
{"taskId": "3", "addBlockedBy": ["1", "2"]}
```
