task_wait ended for task #{{taskId}} (wake {{wakeId}}): {{reason}}

The task is not complete. Reassess the blocker and available authorized work. Do not blindly recreate the wait, subscription or schedule, repeat an external side effect, or treat wake delivery as acceptance evidence. Process any queued result before acting; respect cancellation and authorization boundaries.
