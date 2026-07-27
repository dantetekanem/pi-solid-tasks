# Changelog

## 0.7.4

### Added

- `tasks_done` clears a fully completed task list in one call and refuses while unfinished work remains.
- Strict task-order and completion-contract enforcement.
- Safe handling for interrupted or failed background work.

### Removed

- Remove `task_execute` and the pi-subagents execution integration; pi-tasks now focuses on task tracking and background-process output/stopping.
