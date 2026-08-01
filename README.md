# pi-tasks

A focused task-tracking extension for [pi](https://pi.dev). It keeps multi-step work explicit, prevents unfinished tasks from being skipped, and clears a completed list in one call.

This project is derived from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), originally created by tintinweb.

## Tools

- `task_create` — create a task
- `task_list` — list tracked work
- `task_get` — inspect one task
- `task_update` — update status, ownership, metadata, or dependencies
- `tasks_done` — clear the list after every task is completed
- `task_output` — read background task output
- `task_stop` — stop background task execution

## Development

Load the extension directly:

```bash
pi -e ./src/index.ts
```

Run the repository check:

```bash
pnpm check
```

## Behavior

- Work proceeds in task and dependency order.
- A task is completed only after its acceptance criteria are verified.
- Interrupted work stays open.
- Required follow-up work is added to the list before progression.
- Repeated-item work is split when one task would hide partial progress; more than five items always trigger decomposition.
- When the concrete items are unknown, the active task becomes an inventory task and does not change those items.
- Before execution begins, the inventory expands into one task per independently verifiable item or named batches of 4–5 exact items.
- `tasks_done` refuses cleanup while any task is pending or in progress.

### Bulk-work example

For a request to clean 20 branches, the task graph should evolve instead of keeping all cleanup in one task:

1. Start `#1 Inventory branches eligible for cleanup` and discover the full list without deleting branches.
2. Create follow-up tasks such as `#2 Remove branch-01 through branch-05`, continuing through `#5 Remove branch-16 through branch-20`. Each task description lists its five exact branch names and its focused verification.
3. Verify the expanded graph with `task_list`, then complete the inventory task.
4. Execute and verify tasks `#2` through `#5` in order. If one batch fails, that batch stays open without hiding which branches remain.

Use one task per branch when deletion or verification is independently risky. A batch size outside 4–5 needs a concrete cohesion, ordering, safety, or verification reason in its task description.
