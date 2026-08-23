# Event & Automation Platform V1.2

V1.2 turns plugin actions into durable workflows. The server owns event delivery, scheduling, retries, ACL enforcement and execution history; plugins remain short-lived action providers.

## Event contract

Events are stored in `automation_events` before dispatch. Payloads contain resource identifiers and changed field names, never full note bodies or secrets. Metadata carries `source`, `sourceId`, `correlationId`, `causationId`, `depth` and optional batch information. Depth greater than 10 is rejected with `AUTOMATION_LOOP_DETECTED`.

Core HTTP mutations emit Note, Notebook, Tag, Task, Attachment, Diary and Mindmap events. Writes made through Plugin Host API use the same capture contract and carry `source=plugin` or `source=workflow`. Sync-originated events are retained with `source=sync`; workflows ignore them by default.

## Workflow Definition V1

```json
{
  "version": 1,
  "trigger": { "type": "event", "event": "note.created" },
  "steps": [
    {
      "id": "summarize",
      "type": "action",
      "pluginId": "nowenlab.ai",
      "actionId": "summarize",
      "input": { "noteId": "{{event.resource.id}}" }
    }
  ]
}
```

Supported steps are `action`, `condition`, `delay`, `transform` and `stop`. Template roots are limited to `event`, `steps`, `workflow`, `user` and `workspace`. Conditions use a fixed operator list; JavaScript expressions are not accepted.

Action retries require the manifest action to declare both `idempotent: true` and `retryable` not false. Retryable codes use delays of 1, 5 and 30 seconds. Every step receives the stable key `<runId>:<stepId>` as `execution.idempotencyKey`.

## Triggers and reliability

- Event dispatcher claims at most 100 ledger rows per cycle.
- Scheduler persists cron, IANA timezone and `nextRunAt`; a DB claim prevents duplicate delivery.
- Signed webhooks accept at most 256KB, require a five-minute timestamp window, use HMAC-SHA256 and reject replayed signatures.
- Global workflow concurrency is four and per-workflow concurrency is one.
- Running jobs become `interrupted` after restart. They are not silently replayed.
- Backup restore disables workflows, schedules and webhook tokens, and interrupts in-flight runs.
- Events are retained for 14 days; completed runs for 90 days.

## API and runtime boundary

Authenticated management routes are under `/api/automations`. Public capability-token webhooks are under `/api/automation/webhooks/:token` and perform their own token, size, rate and optional signature checks.

MCP exposes `nowen_list_workflows`, `nowen_run_workflow` and `nowen_get_workflow_run`. MCP can run or inspect existing workflows but does not silently create or enable long-lived automation.

Desktop Full runs the scheduler only while its embedded backend is open. For 24x7 schedules use Nowen Server or Docker. Workflow definitions, event ledgers, schedules and run records are server configuration and are not propagated by Sync V2; resources created by a workflow follow the normal Sync V2 path.
