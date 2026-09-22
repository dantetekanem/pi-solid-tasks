Create an initial flat task plan in one call. Prefer this tool when several concrete tasks are already known; use task_create for a single follow-up or custom positioning. Omit kind, parentId, and children by default. Do not wrap the entire plan in one main group. Groups are optional for user-requested grouping or distinct deliverables that each need their own child tasks, not for phases or agent assignments.

## Input

Pass a nonempty `tasks` array in execution order. Root entries accept subject, description, optional activeForm, metadata, kind and parentId. A root group may contain `children`, each with subject, description, optional activeForm and metadata. Children are executable tasks only: no kind, parentId or further children. A root executable task may use parentId to join an existing group; a group cannot have a parent.

```json
{"tasks":[
  {"subject":"Reproduce login timeout","description":"Capture failing case"},
  {"subject":"Fix login timeout","description":"Implement fix and prove regression passes"},
  {"subject":"Document outcome","description":"Record verified behavior"}
]}
```

## Result and workflow

- Creates entries in input order, each parent followed by its children, after existing open work and before completed history.
- Returns every created ID, subject, description and parent link. Executable tasks start pending and unowned; groups derive status from their children.
- Invalid input rejects the whole batch without creating tasks or consuming IDs.
- Position, dependencies and local reference keys are not batch inputs. Use returned IDs with task_update to add genuine prerequisites before starting dependent work.
- Review the returned plan, assign an owner and start the earliest ready task with task_update. Complete verified work with task_done and use its next-task context.

{{bulkWorkDecomposition}}
