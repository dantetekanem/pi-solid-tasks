Yield automatic task continuation while a verified wake-up owns progress. This is a narrow exception, not a general pause, task status, or completion tool.

Use only when ALL these conditions hold:
- External work has already started and its result is necessary for the owned in-progress taskId.
- No authorized work can advance. Every other unfinished executable task must transitively depend on this task. Independent work, another running task, and empty groups cause rejection. Never invent dependencies to qualify.
- One existing wake-up source meets the rules below. Supply exactly one of schedulerTaskId or reviewRunId, never both. Establish the wake-up first, then call task_wait alone, not in a parallel tool batch: Pi terminates a batch only when every result requests termination.
- reason names the actual blocker; expectedSignal names the evidence and work to resume. Neither authorizes new work or side effects.

## Registered external review

For /code-review running in a separate Herdr/Pi session, first call pi-auto-review's agentic_code_review_subscribe from the waiting caller with the exact reviewSessionId, runId, expectedTarget, expectedHead and a timeout of at most 60 minutes. Use its successful registration receipt's runId as reviewRunId. The subscription owns a completion/failure/deadline notification; no scheduler or promised Herdr ping is needed. A review ID, pane name, launch receipt, or prose promise alone does not qualify. Do not subscribe to an unrelated review to silence tasks. The runtime checks the registered caller and review identity, not whether that review is necessary for your task.

This path covers existing external-session reviews only, not native same-session review watchers. A consumed, ended, expired, missing or changed subscription cannot hold continuation. Do not recreate subscriptions to extend a wait. Delivery is not review acceptance: read the saved artifacts before completing the task. Do not request an additional manual ping when the subscription already owns delivery; handle any previously arranged late ping idempotently.

## Existing scheduler wake

A successful schedule_task call must already provide the exact schedulerTaskId. The schedule must be scope: session for this persisted session, enabled and pending/running, with an expiresIn deadline within 24 hours. Scheduling remains a separate action requiring authorization; never create an unrelated reminder just to qualify.

Allowed wakes: prompt; message with triggerTurn enabled; or shell with explicit wakeOn success, failure, or always and timeoutMs from 1 to 600000. notify, never and change-only policies are rejected. For a shell completion check, verify exit codes distinguish the desired result from still pending. An example is a bounded 10-minute completion check with wakeOn: success and stopOn: success; silent unsuccessful checks need no model turns.

## Boundaries and recovery

Never use task_wait for difficulty, failed tests, unfinished implementation or investigation, context pressure, a progress-summary break, user approval/manual action, or work you can still do. Do not poll, sleep, repeatedly call task_wait, reclassify tasks or mark anything complete to qualify. Existing teams report delivery already handles active delegated agents.

The tool preserves task status, owner, dependencies and acceptance criteria, and refuses a second active wait. While Pi runs, a five-second health check verifies the wake-up without model calls or executing scheduled commands. Task changes or invalid wake evidence end the wait and allow one recovery continuation. Scheduler pending delivery gets 30 seconds of grace; an already-running shell gets its timeout plus grace. Neither source promises exactly-once delivery or business-task completion.

Any new agent run, user input, reload, session replacement, tree navigation, active-run abort or model error clears the wait. Idle Escape does not cancel it; send an instruction to change course. Waits are runtime-only. task_wait never changes or cancels a schedule or review subscription. Pi must remain running. Process the result/input first, resume the same owned task, and reassess an ended wait rather than automatically re-arming. Never repeat a merge, release or other side effect because a wake arrived twice.
