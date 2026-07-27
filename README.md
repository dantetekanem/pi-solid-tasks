# pi-tasks

A focused task-tracking extension for [pi](https://pi.dev). It keeps multi-step work explicit, prevents unfinished tasks from being skipped, and clears a completed list in one call.

This is Leo's customized fork.

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

Run checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Behavior

- Work proceeds in task and dependency order.
- A task is completed only after its acceptance criteria are verified.
- Interrupted work stays open.
- Required follow-up work is added to the list before progression.
- `tasks_done` refuses cleanup while any task is pending or in progress.
