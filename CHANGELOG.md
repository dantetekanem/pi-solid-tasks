# Changelog

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
