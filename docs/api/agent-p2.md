# Agent P2 API

All management paths below begin with `/api/agent/library`, require a normal login session, and reject PATs. Pass `workspaceId=personal` or a workspace ID as in P1. There is a 64 KB request-body limit. Errors contain fixed `{code,error}` identifiers, never upstream error bodies or credentials.

| Method/path | Contract |
| --- | --- |
| `GET /templates` | Current user's accessible templates in the query workspace |
| `POST /templates` | `{name,input,allowNote?,allowTasks?,toolIds?}`; `input` is the existing P1 notebook input without `templateId`; write/tool grants default to false/empty |
| `PUT /templates/:id` | `{revision,config}`; owner and expected revision required; editing rotates revision |
| `DELETE /templates/:id` | Removes the owned template; old runs/plans cannot continue with deleted grants |
| `GET /prompts` | Current user's saved Prompt IDs/names |
| `GET /prompts/:id` | Owned Prompt `{name,instruction}` for copying; no tool permissions inherited |
| `GET /tools` | Eligible sandbox plugin actions and this user's discovered/allowlisted MCP tools, including immutable grant revision and destination |
| `GET /connections` | Owned connection metadata; `hasCredential` only, never encrypted/clear secrets |
| `POST /connections` | `{name,url,allowedTools,token?}`; creates an immutable endpoint with encrypted optional bearer credential |
| `POST /connections/:id/discover` | Explicit bounded MCP `tools/list`; filters the result against `allowedTools` and rotates the catalog revision when changed |
| `DELETE /connections/:id` | Revokes an owned connection and all dependent grants |
| `GET /automations` | Owned Agent plans in the query workspace, with enabled state and bound definition |
| `POST /templates/:id/automations` | `{revision,trigger}`; creates a **disabled** existing Automation workflow with exactly one revision-bound Agent step |
| `POST /automations/:id/enabled` | `{enabled}`; revalidates owner, template revision, tool grants and normal Automation workspace administration rights |

To start a saved template through `POST /api/agent/workflows`, add `templateId` and its current `templateRevision` to a P1-shaped request. A stale revision is rejected before model access. The server resolves all execution inputs from the saved template. Remaining supplied input values cannot expand scope or replace the instruction. Existing P1 users do not acquire extension grants by merely passing `extensionCalls` in a model plan.

Supported plan triggers are existing `{type:"schedule",cron,timezone}`, `{type:"event",event}` and `{type:"webhook",requireSignature:true}`; manual definitions also use the existing Automation service. UI schedules offer daily/weekly local times; the API retains existing validated cron support. Update/enable/run/history/delete operations for Automation also remain available through `/api/automations`; Agent steps are revalidated there as well. An automation run completing means its Agent proposal was queued, **not** that a note/task/external operation was approved or saved. `agent_trigger_runs` provides the durable mapping to normal Agent history.

Signed webhooks use existing `/api/automation/webhooks/:token`. Creation returns `webhookCredentials: {token,secret}` only once. Call with `Content-Type: application/json`, `X-Nowen-Timestamp` as Unix seconds, and `X-Nowen-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`. Existing five-minute timestamp, replay and size/rate limits apply. Payloads are not used as instructions. Do not log or place the signature secret in a request URL.

P1 run details add `extensionReceipts: [{callIndex,toolId,status}]`. Live previews may add `extensionCalls: [{toolId,input,tool}]` and bounded `extensionResults`. `actions.kind` may be `extensions`. Calls remain proposals until the one-use approval is consumed; note/task actions commit first. No HTTP/SQLite transaction can atomically roll back a remote side effect. An `uncertain` receipt prohibits replay; inspect the target service before issuing a new request.

Additional codes include `TEMPLATE_NOT_FOUND`, `TEMPLATE_CHANGED`, `TOOL_GRANT_REVOKED`, `TEMPLATE_LIMIT`, `CONNECTION_NOT_FOUND`, `CONNECTION_LIMIT`, `MCP_URL_DENIED`, `MCP_REQUEST_FAILED`, `MCP_RESPONSE_INVALID`, `MCP_SCHEMA_UNSUPPORTED`, `MCP_CATALOG_LIMIT`, `EXTENSION_RESULT_UNCERTAIN`, `AGENT_TRIGGER_DENIED` and `WEBHOOK_SIGNATURE_REQUIRED`. Unknown transport errors remain generic; no provider/remote response is returned as an exception message.

See [architecture](../architecture/agent-p2.md) for explicit MCP 2026 compatibility, public HTTPS restrictions, plugin trust/permission limits, ten-minute preview expiry and server-only configuration persistence.
