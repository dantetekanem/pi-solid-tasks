# pi-solid-tasks

A task list for [Pi](https://pi.dev) that keeps unfinished work visible and checks what can start next.

Ask Pi to fix a bug or build a feature. The agent breaks the work into tasks, updates them as it goes, and shows progress above the editor. If one task needs another to finish first, the extension checks that dependency before letting the agent move on.

## Install

Requires Pi 0.85.1 or newer.

Install from npm:

```bash
pi install npm:pi-solid-tasks
```

Or install from Git:

```bash
pi install git:github.com/dantetekanem/pi-solid-tasks
```

Restart Pi or run `/reload`. No manual configuration is needed.

This package runs with full system access; review the source before installing.

## Use

Describe the work in your normal prompt. The agent manages the task list for multi-step work; you do not need to call the task tools yourself.

- `/tasks` opens the full list, manual controls, and settings.
- `/add-task <task>` adds a rough task for the agent to clarify and carry out. If the agent is busy, the request waits until its current run finishes.

```text
/add-task Fix the login timeout and cover it with a regression test
```

Tasks move from `pending` to `in_progress` to `completed`. The agent is instructed to verify the work before marking it complete. The extension checks task state, ownership, and dependencies; it cannot tell whether a fix is correct.

## Features

- One active task per owner. An agent cannot claim another task while it owns unfinished work. To abandon a task, it is instructed to undo the work before deleting the record.
- Dependencies checked before starting or finishing. Missing tasks and dependency loops are rejected without changing the list. Redundant dependencies are removed automatically.
- Up to four tasks in progress with different owners. Independent work can proceed in parallel, but tasks cannot jump past earlier work unless another owner is working on it or it depends on the later task. This package tracks ownership; it does not launch agents.
- Whole plans in one call. `tasks_create_in_batch` creates an ordered list, with optional groups and subtasks. An invalid batch creates nothing.
- The next task comes back with completion. `task_done` marks one task complete and returns the next ready task's details, so the agent does not need to fetch the list again. It still has to claim and start that task.
- Insert follow-up work where it belongs. `task_append` and `task_prepend` add tasks beside an existing open task, putting unfinished prerequisites ahead of the tasks that need them.
- Groups with one level of subtasks. Each group shows completed/total tasks and a percentage. Its status follows its children, and the group itself does not take an execution slot. Flat lists remain the default.
- A compact progress widget. Up to five task rows, at most two subtask rows, single-line labels, and elapsed time for active tasks. Hidden tasks still count toward progress. Waiting tasks show `(on wait)` with a paused spinner.
- Large batches broken into checkable work. Agent instructions require an inventory first when the items are unknown, then separate tasks or named batches before execution.
- Reminders when unfinished work goes idle. After five idle minutes, Pi asks the agent to reassess what it can do. There are at most two reminders per user request.
- Waiting for external results. `task_wait` pauses reminders when no other work can advance and a verified wake-up is registered. The task stays in progress. This requires a compatible wake-up provider; see the [wait requirements](prompts/task-wait.md).
- Completion cleanup. `tasks_done` clears a finished list in one call and refuses while anything remains unfinished. The agent is instructed to use it before its final response unless you ask to keep the records.

See the [changelog](CHANGELOG.md) for release history.

## Idle reminders

Idle reminders start agent turns and pause for open question dialogs. Cancellation and model errors do not trigger automatic retries. Opening or reloading a session does not start work.

## Settings and storage

Open `/tasks` and choose **Settings** to adjust visible rows, the hidden-task indicator, storage, and automatic cleanup.

| Scope | What it means |
| --- | --- |
| `session` (default) | A saved list for each Pi session, available when you resume it |
| `project` | A saved list shared by sessions in the same project |
| `memory` | A temporary list that is not saved to disk |

Settings and saved tasks live under `~/.pi/tasks/` by default. Completed flat lists also clear automatically by default. Grouped lists stay until cleared; clearing completed work keeps finished subtasks inside an unfinished group.

Progress measures completed tasks, not effort or time remaining. Adding tasks can lower the percentage.

## Agent tools

The agent receives instructions for these tools automatically.

| Tool | Purpose |
| --- | --- |
| `tasks_create_in_batch` | Create an ordered plan, optionally with groups and subtasks |
| `task_create` | Create one task or group |
| `task_append` | Create a task after an existing open task |
| `task_prepend` | Create a task before an existing open task |
| `task_list` | Show tasks and execution order |
| `task_get` | Read one task and its dependencies |
| `task_update` | Change status, ownership, details, or dependencies |
| `task_done` | Complete one task and return the next ready task |
| `tasks_done` | Clear the completed list |
| `task_wait` | Pause for an external result with a verified wake-up |
| `task_output` | Read output from a tracked background process |
| `task_stop` | Stop a tracked background process |

## Development

```bash
pnpm install
pi -e ./src/index.ts
pnpm check
```

`pnpm check` runs linting, type checking, tests, and the build. If this checkout is already installed in Pi, use `/reload` to load local changes.

Agent instructions live in [`prompts/`](prompts/) as Markdown, loaded by [`src/prompts.ts`](src/prompts.ts). They can be edited without changing the TypeScript implementation. Reload Pi after editing them.

## Credits

Based on [pi-tasks](https://github.com/tintinweb/pi-tasks) by tintinweb. Licensed under [MIT](LICENSE).
