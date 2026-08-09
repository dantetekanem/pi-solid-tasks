# pi-tasks

Strict task tracking for [pi](https://pi.dev). It keeps multi-step work explicit, supports dependency-aware parallel work, and refuses to discard unfinished lists.

## Install

```bash
pi install git:github.com/dantetekanem/pi-tasks
```

Pi extensions run with full system access. Review third-party code before installing it.

## Use

- `/tasks` opens the task manager and settings.
- `/add-task <task>` adds a draft for the agent to refine and complete.

The agent receives seven tools:

| Tool | Action |
| --- | --- |
| `task_create` | Create and position a task |
| `task_list` | List tracked work |
| `task_get` | Read one task |
| `task_update` | Update status, ownership, metadata, or dependencies |
| `tasks_done` | Clear a fully completed list |
| `task_output` | Read tracked background-process output |
| `task_stop` | Stop a tracked background process |

## Task model

- Tasks move from `pending` to `in_progress` to `completed`.
- An owner must finish its current task, or undo its work and delete it, before claiming another.
- A task is ready when all `blockedBy` prerequisites are complete and it has no other owner.
- Work starts in list order. A later task can start when earlier work is active under another owner or depends on it.
- Independent tasks can therefore run in parallel without letting one owner skip unfinished work.
- Missing dependencies, self-dependencies, and cycles are rejected atomically.
- Redundant transitive dependencies are removed, leaving only immediate prerequisites.
- A task cannot start or complete while a prerequisite is unfinished.
- `tasks_done` refuses cleanup while any task remains open.

For example, tasks `#1` and `#2` can run together while task `#3`, with `blockedBy: ["1", "2"]`, waits for both.

## Configure

Open `/tasks` and choose **Settings** to change storage (`memory`, `session`, or `project`), widget visibility, and automatic cleanup. The defaults persist tasks per session and clear completed tasks after the full list finishes.

Configuration and persisted task data live under `~/.pi/tasks/` by default.

## Develop

```bash
pnpm install
pi -e ./src/index.ts
pnpm check
```

`pnpm check` runs linting, type checking, tests, and the build.

Derived from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), originally created by tintinweb. Licensed under [MIT](LICENSE).
