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
- At most four tasks can be `in_progress` at once, leaving the fifth default widget slot available for the next queued task.
- Missing dependencies, self-dependencies, and cycles are rejected atomically.
- Redundant transitive dependencies are removed, leaving only immediate prerequisites.
- A task cannot start or complete while a prerequisite is unfinished.
- `tasks_done` refuses cleanup while any task remains open.

For example, tasks `#1` and `#2` can run together while task `#3`, with `blockedBy: ["1", "2"]`, waits for both.

## Projects and subtasks (prototype)

Describe the goal; the agent creates and maintains the tasks. It uses `task_create` with `kind: "group"` for a top-level task and `parentId` for its direct executable subtasks. There is exactly one subtask level: no nested groups or sub-subtasks. Kind and parent are fixed at creation.

```text
Build this project       2/3 subtasks · 67%
├─ Implement login       completed
├─ Verify login          completed
└─ Deploy preview        pending
```

Groups derive their status from their children. Empty groups remain pending; groups complete when all children complete. Only executable tasks have owners and dependencies or consume parallel-work slots. Add a final verification subtask when an issue needs an acceptance check.

Progress counts completed executable subtasks, not groups or estimated effort. Adding discovered work can lower the percentage. `task_list` shows the hierarchy and a separate execution queue; nesting does not reorder that queue. `task_get` shows parent, children and progress.

The widget and `/tasks` show connecting lines between each task and its subtasks. The widget's visible-task limit applies to executable rows; parent summaries add rows. `/tasks` shows all tracked work. Manual creation is optional; the agent manages the structure.

Hierarchical lists stay until explicitly cleared, even when automatic cleanup is enabled. **Clear completed** keeps completed subtasks inside open projects so their progress stays intact. Individual groups with children cannot be deleted. `tasks_done` clears a fully completed list on request.

Storage still follows your selected scope: session by default, project for sharing across sessions, or memory for temporary work.

## Configure

Open `/tasks` and choose **Settings** to change storage (`memory`, `session`, or `project`), widget visibility, and automatic cleanup. The defaults persist tasks per session and clear completed flat lists after the full list finishes. Hierarchical projects are retained until explicitly cleared.

Configuration and persisted task data live under `~/.pi/tasks/` by default.

## Develop

```bash
pnpm install
pi -e ./src/index.ts
pnpm check
```

`pnpm check` runs linting, type checking, tests, and the build.

Agent instructions, tool descriptions, reminders, and draft prompts live in `prompts/*.md`. `src/prompts.ts` loads them relative to the package, with `{{name}}` placeholders for runtime values. Blank lines separate entries in `task-guidelines.md`. Tool schemas and UI labels remain in TypeScript.

Derived from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), originally created by tintinweb. Licensed under [MIT](LICENSE).
