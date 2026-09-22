# Changelog

## 0.8.15

### Fixed

- Save the four-turn task reminder as a hidden session message, so later requests replay it in the same place. Anthropic no longer drops thinking blocks with `prefix_binding_mismatch` after a reminder.
- Send the reminder after the whole tool batch. Skip it when every tool in the batch ends the run, and do not send it again after a session reload.

## 0.8.12

### Fixed

- Wait five idle minutes before nudging the agent about unfinished tasks, with at most two reminders per user request. Automatic turns do not reset the limit.
- Ask the agent to reassess available work rather than forcing continuation or repeating the last command.

## 0.8.11

### Added

- `task_wait` pauses automatic continuation for a verified same-session scheduler wake or registered external review handoff, without changing task state.
- Show `(on wait)` beside the waiting task in the footer list and pause its spinner until resumption.

### Fixed

- Handle review handoffs arriving before settlement or during wait reconciliation without stale recovery messages.

## 0.8.10

### Added

- `task_append` and `task_prepend` create new tasks after or before an existing open task and return the execution queue.

### Changed

- Sort unfinished prerequisites before dependent tasks when inserting beside an existing task, without changing dependencies or task IDs.

## 0.8.9

### Changed

- Lighten the widget header percentage with a 20% white tint of the accent color in truecolor terminals.

## 0.8.8

### Fixed

- Keep multiline task titles and active labels on one widget row to prevent stale spinner and footer fragments. Preserve the full stored draft.

## 0.8.7

### Removed

- Remove the blocking-question task tool and its continuation hold; retain open question dialog handling.

## 0.8.6

### Added

- Resume settled agent runs automatically when tracked tasks remain unfinished, while respecting question holds, active delegated work, cancellation, and model errors.

### Changed

- Default to flat executable tasks; reserve groups for explicit requests or distinct deliverables that need subtasks.
- Require Pi 0.85.1 or newer for runtime continuation.

## 0.8.5

### Fixed

- Require `tasks_done` before the final response for fully verified queues, including grouped lists. Retain completed records only when the user explicitly asks to keep them.

## 0.8.4

### Added

- `tasks_create_in_batch` creates initial plans with one level of group children, rejecting invalid batches without partial changes.
- `task_done` completes verified tasks and returns full next-ready task context without claiming or starting it.

### Changed

- Prefer batch creation and completion handoffs in agent prompts to avoid redundant `task_list` and `task_get` calls.

## 0.8.3

### Added

- Track top-level tasks with one level of direct subtasks, completed/total progress, percentages, and tree connectors.
- Retain completed hierarchical task lists until explicitly cleared.

### Changed

- Keep grouping tasks outside execution limits, ownership, and dependency scheduling.
- Load agent prompts from Markdown files in `prompts/`.

## 0.8.1

### Changed

- Limit parallel `in_progress` work to four tasks so the default five-task widget keeps the next queued task visible.

## 0.8.0

### Added

- Run ready independent tasks in parallel with distinct owners while dependent tasks wait for every declared prerequisite.
- Reject missing, self-referential, and cyclic dependency updates atomically.
- Reduce dependency graphs to immediate prerequisites and remove redundant transitive blocker edges.
- Enforce dependency-safe completion and reject mutations that would retroactively block active/completed work.
- Display multiple in-progress tasks within the configured widget limit.

### Changed

- Use list order to prevent jumping past earlier pending work while still allowing later tasks that are prerequisites or parallel work actively owned by someone else.
- Require each owner to finish or fully undo its current task before claiming another; unfinished work can no longer be parked through `task_update`.

## 0.7.7

### Added

- Create tasks before or after an open task, or at the beginning or end of open work; the end remains the default.

## 0.7.6

### Changed

- Replace repository-distribution copy with attribution to the original `tintinweb/pi-tasks` project.

## 0.7.5

### Changed

- Repeated-item work now follows an inventory-first task contract and expands into independently verifiable item tasks or named batches of 4–5 exact items before execution.
- Mark the GitHub-only fork as private and replace its npm publish hook with an explicit repository check command.

## 0.7.4

### Added

- `tasks_done` clears a fully completed task list in one call and refuses while unfinished work remains.
- Strict task-order and completion-contract enforcement.
- Safe handling for interrupted or failed background work.

### Removed

- Remove `task_execute` and the pi-subagents execution integration; pi-tasks now focuses on task tracking and background-process output/stopping.
