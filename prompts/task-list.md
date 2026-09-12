Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see the ready set (status: 'pending', no owner, all blockedBy prerequisites completed, and no skipped earlier work)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- To claim up to {{maxParallelTasks}} ready independent tasks for parallel work by distinct owners
- To keep each owner on one task until it is finished or fully undone
- When task_done's next-task context is missing or stale, or you need the broader ready set for parallel work
- Start ready work in listed order; a later task can start only when earlier open work is actively owned by another owner or depends on it

## Output

Flat lists return open tasks in configured order, followed by completed tasks. Hierarchical lists show a tree with completed/total leaf subtasks and percentage, plus the explicit execution queue (tree display order is not execution order). Groups summarize children and are not executable. Several executable tasks may be in_progress in parallel. Each summary includes:
- **id**: Stable task identifier (use with task_get, task_update or task_done)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Owner identifier if assigned, empty if available
- **blockedBy**: Open immediate prerequisite task IDs; all must be completed before the task is ready

Only immediate prerequisites are retained; redundant transitive blockers already implied by another prerequisite are removed.

Use task_get for full requirements when they are not already present in current tool context. Normal completion uses task_done, whose response supplies the next task without another list/get round trip.
