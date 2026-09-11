Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Immediate prerequisite tasks that must complete before this one can start

Redundant transitive blockers are omitted. If #3 depends on #2, a task blocked by both #2 and #3 retains only immediate prerequisite #3.

## Tips

- A pending task is ready when every blockedBy prerequisite is completed, no other owner has claimed it, and starting it would not skip earlier open work.
- Independent tasks may run in parallel when earlier work is active under a distinct owner.
- At most {{maxParallelTasks}} tasks can be in progress at once; keep the next ready task pending in the queue.
- Use task_list to see all tasks in summary form.
