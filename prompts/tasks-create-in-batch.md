Create an ordered initial plan for authorized work in one call. Use task_create for individual additions or custom positioning.

Pass a nonempty tasks array; each item has subject and acceptance-based description, with optional activeForm and metadata. Flat executable tasks are the default. A kind: group entry may have executable children, or a task may join an existing root group via parentId. Only one child level; do not wrap the whole request in a redundant group.

Example: {"tasks":[{"subject":"Reproduce login timeout","description":"Capture the failing case"},{"subject":"Fix login timeout","description":"Repair it and verify the regression"}]}.

The call is atomic: invalid input creates nothing. Entries are appended after open work and before completed history; executable tasks start pending and unowned. It returns their IDs and details. Use task_update with returned IDs for dependencies, ownership, and starting; batch input has no dependency or position fields. Follow shared bulk-work guidance before executing a large inventory.
