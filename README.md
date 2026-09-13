# pi-solid-tasks

Strict task tracking for [Pi](https://pi.dev). Keep unfinished work visible, give tasks clear owners, and check dependencies before moving on. The agent manages the list; you can inspect it at any time.

## Install

```bash
pi install git:github.com/dantetekanem/pi-solid-tasks
```

Requires Pi 0.85.1 or newer. Restart Pi or run `/reload` in an open session. No manual configuration needed.

Keep only one task extension enabled: this package uses the same tool names as `pi-tasks`. Pi extensions run with full system access, so review the code before installing.

## Use

Ask Pi to work on something. For multi-step work, the agent creates tasks, tracks progress, and checks the results before marking them complete.

- `/tasks` opens the task list, manual controls, and settings.
- `/add-task <task>` adds a draft for the agent to turn into a clear task and carry out.

```text
/add-task Fix the login timeout and cover it with a regression test
```

The widget shows up to five task rows, including parents, with at most two subtask rows across the whole widget. Completed groups collapse to one dimmed parent row. Hidden work still counts toward progress. Open `/tasks` for the full list.

## What makes the tasks solid

- Tasks move through `pending`, `in_progress`, and `completed`.
- An owner must finish its current task, or undo the work and delete the task, before claiming another. Unfinished work cannot be parked to skip ahead.
- Dependencies must all be complete before a task can start or finish. Missing dependencies, self-dependencies, and cycles are rejected without partially changing the list.
- Work follows list order. Later tasks can start when earlier work belongs to another active owner or depends on the later task.
- Up to four independent tasks can run in parallel, each with a different owner.
- Only immediate prerequisites are kept; redundant transitive dependencies are removed.
- `tasks_done` refuses to clear a list while anything remains unfinished.

These checks enforce task state and order. You and the agent still own the quality of the work and its verification.

When an agent run settles with unfinished tasks, the extension sends a continuation message that starts another run. This repeats until the queue is complete, without a timer or a user nudge. It does not claim or complete tasks itself, and it does not start work merely because you opened or reloaded a session.

Open question dialogs hold continuation. For a blocking question in chat, `task_wait` shows the question and holds continuation until your next message; the task stays open. Extension reports do not release that hold. Active `pi-extended-teams` agents use their existing report delivery to resume the lead. Escape/abort and model errors do not trigger automatic retries.

## Projects and subtasks

Flat tasks are the default, including for work with many steps or several agents. A parent that only repeats the overall request adds no useful division. Use groups only when requested or when distinct deliverables each need their own child tasks; dependencies and ownership do not require grouping.

If you explicitly request a grouped plan, `tasks_create_in_batch` supports it:

```json
{"tasks":[{"kind":"group","subject":"Fix login timeouts","description":"Login works with regression coverage","children":[
  {"subject":"Reproduce the timeout","description":"Capture a failing case"},
  {"subject":"Fix session handling","description":"Implement the fix"},
  {"subject":"Verify the fix","description":"Make the regression pass"}
]}]}
```

The task list shows progress within each group:

```text
Fix login timeouts       2/3 tasks · 67%
├─ Reproduce the timeout completed
├─ Fix session handling completed
└─ Verify the fix        pending
```

Groups support one level of executable subtasks. Their status and progress come from their children; groups do not need owners or consume parallel-work slots. Progress counts completed subtasks, not estimated effort, so adding work can lower the percentage.

The widget and `/tasks` show the tree. The agent also sees an execution queue: nesting does not change task order. Completed groups stay visible while other work remains. Once every task is completed and verified, the agent calls `tasks_done` before its final response unless you ask to keep the records. Clearing completed work keeps finished subtasks inside an open project.

## Settings and storage

Open `/tasks` → **Settings** to choose storage scope, widget visibility, and automatic cleanup.

| Scope | Storage |
| --- | --- |
| `session` (default) | A separate persisted list for each Pi session |
| `project` | A persisted list shared across sessions in the same project |
| `memory` | Temporary, in-memory tasks |

Settings and persisted tasks live under `~/.pi/tasks/` by default. The package name does not change this location. Completed flat lists also clear automatically by default; grouped lists use the agent's final `tasks_done` call.

## Agent tools

Create a known initial plan with `tasks_create_in_batch`; invalid input creates nothing. Start work with `task_update`. When verified, call `task_done`: it returns the next ready task's details in the same response, without another list/get round trip. The agent still needs to claim and start that task. If nothing is ready, the response reports unfinished work or confirms completion. For a fully verified queue, the final step is `tasks_done`, including for grouped lists, unless you asked to keep the records.

| Tool | Purpose |
| --- | --- |
| `task_create` | Create a task or group and choose its position |
| `tasks_create_in_batch` | Create an ordered plan with optional group children |
| `task_list` | Show tracked work and the execution queue |
| `task_get` | Read a task, its dependencies, and progress |
| `task_update` | Update status, ownership, details, or dependencies |
| `task_done` | Complete one task and return the next ready task |
| `task_wait` | Ask a blocking question and wait for the next user message |
| `tasks_done` | Clear a fully completed list |
| `task_output` | Read tracked background-process output |
| `task_stop` | Stop a tracked background process |

## Prompts

Agent prompts live in [`prompts/`](prompts/) as Markdown, separate from the implementation:

- `completion-contract.md`, `bulk-work-decomposition.md`, and `task-guidelines.md` define the workflow.
- `task-create.md`, `tasks-create-in-batch.md`, `task-list.md`, `task-get.md`, `task-update.md`, `task-done.md`, `tasks-done.md`, `task-output.md`, and `task-stop.md` describe the tools.
- `task-done-handoff.md` supplies the completion response and next-step instructions.
- `task-continuation.md` supplies the runtime idle continuation; `task-wait.md` describes the blocking-question tool.
- `system-reminder.md` reminds the agent about unfinished work.
- `draft-task-description.md` and `draft-task-kickoff.md` handle `/add-task`.

[`src/prompts.ts`](src/prompts.ts) loads these files relative to the package and fills `{{name}}` placeholders. Blank lines separate entries in `task-guidelines.md`. Keep new agent instructions in `prompts/*.md`; tool schemas, UI labels, and execution logic stay in TypeScript. Run `/reload` after editing prompts.

## Development

```bash
pnpm install
pi -e ./src/index.ts
pnpm check
```

`pnpm check` runs linting, type checking, tests, and the build. If this checkout is already installed in Pi, use `/reload` to load local changes.

Derived from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), originally created by tintinweb. Licensed under [MIT](LICENSE).
