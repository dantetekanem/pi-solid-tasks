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

Open question dialogs hold continuation. Active `pi-extended-teams` agents use their existing report delivery to resume the lead. Aborting an active run and model errors do not trigger automatic retries.

### Waiting for an external review

For `/code-review` running in a separate Herdr/Pi session, first use `agentic_code_review_subscribe` in the waiting caller. Supply the exact review session/run, expected target/head, and a timeout of at most 60 minutes. The matching pi-auto-review extension registers and delivers the completion, failure or deadline notice; a promised direct ping alone does not qualify.

After a successful subscription, call `task_wait` alone:

```json
{"taskId":"2","reviewRunId":"6289edd8-24e4-4500-9a08-f72e7af1c2df","reason":"The subscribed PR review is still running","expectedSignal":"Read its saved report and reconcile the findings"}
```

The task must be owned and in progress; all other unfinished work must depend on it. Supply either `reviewRunId` or `schedulerTaskId`, never both. The synchronous `agentic-code-review:wait-probe` v1 contract verifies the subscription belongs to this caller and retains its original finite deadline. It does not prove the caller launched the reviewer or that the review is relevant to the task. Missing, consumed, expired or changed registrations end the wait, never complete the task.

This subscription path covers external-session reviews, not the native same-session watcher. Both extensions must be loaded with this integration; changing files does not update an already-running tool registration. No active pane is reloaded automatically. Avoid arranging an additional manual ping, and handle any already-arranged duplicate without repeating side effects. After reload, subscriptions and waits must be reassessed explicitly.

### Waiting for a scheduled result

`task_wait` holds continuation for an external operation that is already running, such as a review with a scheduled completion check. It requires an owned, in-progress task and an exact existing scheduler ID. Every other unfinished task must depend on that task; independent work and empty groups prevent waiting. It does not change task status, ownership, dependencies, or the schedule.

Create the authorized schedule first, then call `task_wait` alone, not in a parallel batch with other tools:

```json
{"taskId":"2","schedulerTaskId":"task_example_123","reason":"The external review is still running","expectedSignal":"The completion check delivers the finished review; read its evidence and resume integration"}
```

The schedule must belong to the same persisted session, be enabled and pending/running, and have an `expiresIn` deadline within 24 hours. It must wake the agent: `prompt`, a waking `message`, or `shell` with explicit `wakeOn: success|failure|always` and `timeoutMs` between 1 and 600000. A shell completion check can use `wakeOn: success` and `stopOn: success`; its exit code must distinguish completion from still pending. Notifications, silent checks, and `wakeOn: change` are not accepted. Failed tests, difficult implementation, and user approval/manual actions are not reasons to call this tool.

While waiting, a read-only health check runs every five seconds without model calls or executing the scheduled command. The footer shows the task, schedule, and deadline. Changed task/schedule configuration, cancellation, removal, expiry, exhausted runs, stalled execution, or failed delivery end the wait and permit one recovery continuation. Pending delivery gets 30 seconds of grace; an already-running shell may finish within its timeout plus grace. Normal scheduler or early review delivery owns the next run without an extra wait-generated wake.

Waits are runtime-only. New agent runs, user input, reload, session replacement, tree navigation, active-run aborts, and model errors clear them. Idle Escape is not a wait-cancel shortcut; send an instruction to resume or change course. Reload/startup does not start work. The scheduler job stays intact and Pi must remain running for both monitoring and scheduled execution. After resuming, the agent must verify the result, handle duplicate messages without repeating side effects, and reassess before another wait.

Compatibility: the adapter reads `@jl1990/pi-scheduler` 0.5.x state version 2 at `PI_SCHEDULER_STATE_FILE` or `~/.pi/agent/state/scheduler/tasks.json`. It never writes that file and rejects unsupported or unverifiable state. The scheduler has no atomic handoff or consumption acknowledgment, so exactly-once delivery across extensions is not guaranteed. Runtime checks verify state and dependencies, not the truth of the agent's blocker explanation.

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
| `task_append` | Create a new task after an existing open task |
| `task_prepend` | Create a new task before an existing open task |
| `tasks_create_in_batch` | Create an ordered plan with optional group children |
| `task_list` | Show tracked work and the execution queue |
| `task_get` | Read a task, its dependencies, and progress |
| `task_update` | Update status, ownership, details, or dependencies |
| `task_wait` | Yield continuation for a verified scheduler wake or registered external review handoff |
| `task_done` | Complete one task and return the next ready task |
| `tasks_done` | Clear a fully completed list |
| `task_output` | Read tracked background-process output |
| `task_stop` | Stop a tracked background process |

For new work beside an existing task, pass its ID as `taskId`:

```json
{"taskId":"3","subject":"Verify the fix","description":"Run the focused regression"}
```

Use `task_append` for after, or `task_prepend` for before. Both first pull unfinished prerequisites ahead of dependent tasks, then insert next to the anchor. Completed history stays last. Dependencies, IDs, and owners do not change. The response includes the new task and the sorted execution queue. An optional `parentId` places the new task in a group; it is not inherited from the anchor. Missing or completed anchors are rejected.

## Prompts

Agent prompts live in [`prompts/`](prompts/) as Markdown, separate from the implementation:

- `completion-contract.md`, `bulk-work-decomposition.md`, and `task-guidelines.md` define the workflow.
- `task-create.md`, `task-append.md`, `task-prepend.md`, `tasks-create-in-batch.md`, `task-list.md`, `task-get.md`, `task-update.md`, `task-done.md`, `tasks-done.md`, `task-output.md`, and `task-stop.md` describe the tools.
- `task-done-handoff.md` supplies the completion response and next-step instructions.
- `task-wait.md` defines wait admission and misuse rules; `task-wait-ended.md` explains recovery without claiming completion.
- `task-continuation.md` supplies the runtime idle continuation.
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

The cross-package review handoff test is opt-in. Set `PI_AUTO_REVIEW_CHECKOUT` to the matching pi-auto-review checkout and run `node node_modules/vitest/vitest.mjs run test/review-handoff.integration.test.ts`. It loads both components through the installed Pi extension loader and `AgentSession`, using the real tool wrappers, custom-message delivery and settlement events. Only the model/auth and resource inputs are stubbed; sessions and review artifacts stay in temporary directories, not live panes or reviews. Without that path, this integration test is skipped.

Derived from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), originally created by tintinweb. Licensed under [MIT](LICENSE).
