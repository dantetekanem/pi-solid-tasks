# Changelog

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
