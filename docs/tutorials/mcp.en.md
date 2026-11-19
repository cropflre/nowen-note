# MCP Server installation and usage

> Connect Claude Code, Cursor, VS Code, and other MCP clients to Nowen Note so they can search, read, and maintain notes within the permissions you grant.

[Back to tutorials](./README.md) · [简体中文](./mcp.md) · [Package README](../../packages/nowen-mcp/README.md)

## What you need to know

- MCP support is still available under `packages/nowen-mcp/`.
- New Docker images containing the embedded MCP runtime can expose `/mcp` after an administrator enables it in Settings. No host Node.js/npm installation or separate container is needed. Older images must be upgraded. See [Docker deployment](./docker-deploy.md).
- The **standalone source installation** below remains available and requires Node.js 24.22.1+ (24.x LTS), Git, and npm.
- Replace every `/absolute/path/...` placeholder with the real absolute path on your computer.
- When Nowen Note runs on a NAS or another server, `NOWEN_URL` must be reachable from the computer running the AI client, for example `http://192.168.1.20:3001`.
- Use a dedicated restricted Personal API Token instead of storing an administrator password in the MCP configuration.

## Five-minute setup

### 1. Verify the Nowen Note server

Open the server from the same computer that runs your MCP client:

```text
http://192.168.1.20:3001
```

Use `http://localhost:3001` only when Nowen Note runs on that same computer.

### 2. Check prerequisites

```bash
node --version
npm --version
git --version
```

Node.js must be version 20 or newer.

### 3. Clone and build the MCP server

#### Windows PowerShell

```powershell
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note\packages\nowen-mcp
npm install
npm run build
Test-Path .\dist\scoped-entry.js
```

The final command must return `True`. This file is the launcher's internal build entry; do not configure MCP clients to run it directly. Clients should run `bin/nowen-mcp.mjs`.

#### macOS / Linux / WSL

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note/packages/nowen-mcp
npm install
npm run build
test -f ./dist/scoped-entry.js && echo "MCP build OK"
```

`npm test` is a development validation command, not an installation requirement.

### 4. Create a Personal API Token

In Nowen Note, open:

```text
Settings → Personal access tokens → Create token
```

Recommended settings:

1. Create a separate token for each client.
2. Grant only the required scopes, such as `notes:read` and `notes:write`.
3. Restrict the token to specific notebooks.
4. Choose read-only or read-write per notebook.
5. Include child notebooks only when needed.
6. Set an expiration date.

Copy the generated token, for example `nkn_xxx`.

### 5. Resolve the stable launcher path

Windows PowerShell:

```powershell
(Resolve-Path .\bin\nowen-mcp.mjs).Path
```

macOS / Linux / WSL:

```bash
realpath ./bin/nowen-mcp.mjs
```

Windows paths must be escaped in JSON:

```json
"C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\bin\\nowen-mcp.mjs"
```

On macOS, Linux, and WSL, the launcher path must start with `/`. A value such as `home/user/...` is relative, so the client may append it to its own working directory before Node can execute the launcher.

## Claude Code

macOS / Linux / WSL:

```bash
claude mcp add nowen-note --scope user \
  --env NOWEN_URL=http://192.168.1.20:3001 \
  --env NOWEN_API_TOKEN=nkn_xxx \
  -- node /home/yourname/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs
```

Windows PowerShell:

```powershell
claude mcp add nowen-note --scope user `
  --env NOWEN_URL=http://192.168.1.20:3001 `
  --env NOWEN_API_TOKEN=nkn_xxx `
  -- node "C:\Users\YourName\nowen-note\packages\nowen-mcp\bin\nowen-mcp.mjs"
```

Verify it:

```bash
claude mcp get nowen-note
claude mcp list
```

Restart the Claude Code session after changing the configuration.

Official reference: [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)

## Cursor

Use `.cursor/mcp.json` for a project configuration or `~/.cursor/mcp.json` for a global configuration.

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/home/yourname/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

On Windows, replace the script path with an escaped absolute Windows path. Fully quit and reopen Cursor, then confirm that `nowen-note` appears under MCP or Available Tools.

Official reference: [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)

## VS Code / GitHub Copilot

Run `MCP: Add Server` from the Command Palette, or create `.vscode/mcp.json`:

```json
{
  "servers": {
    "nowen-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/yourname/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

VS Code uses the top-level `servers` field, not Cursor's `mcpServers` field.

Run `MCP: List Servers`, select `nowen-note`, and choose Start or Restart. Choose Show Output when debugging. Avoid committing real tokens to a repository; prefer user-level configuration or VS Code input variables for secrets.

Official reference: [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

## Claude Desktop and generic stdio clients

Most clients that accept local stdio MCP servers use this structure:

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

For local stdio, use the MCP developer configuration exposed by your client. A local stdio script cannot be used as a remote connector. Clients supporting Streamable HTTP with a Bearer header can instead connect to the Docker embedded `/mcp` endpoint using a Personal API Token. Standalone HTTP gateways still use a separate gateway secret; OAuth-only clients cannot connect directly yet.

Official reference: [Local MCP servers on Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## MCP startup diagnostics

Configure clients to run `bin/nowen-mcp.mjs`. The stable launcher validates Node.js, `NOWEN_URL`, the compiled entry, and dependencies before loading the server. Structured diagnostics go to stderr; stdout remains reserved for the MCP stdio protocol.

For long-session debugging, enable an optional heartbeat:

```json
"NOWEN_MCP_HEARTBEAT_MS": "300000"
```

Heartbeats are disabled by default. Exit logs distinguish parent stdin closure, termination signals, uncaught exceptions, unhandled rejections, and normal process exit.
## Verify the connection

After restarting the client, confirm that tools such as these appear:

```text
nowen_list_notebooks
nowen_list_notes
nowen_read_note
nowen_search
```

Start with a read-only test:

```text
Use the Nowen Note MCP server to list the notebooks I can access. Do not modify anything.
```

Then test search:

```text
Use Nowen Note MCP to search for "test" and return only titles and notebook names.
```

Only after read operations work should you test creating or updating a note.

## Update the MCP server

```bash
git pull
cd packages/nowen-mcp
npm install
npm run build
```

Restart the MCP server or the client afterwards. If you move the repository, update the absolute script path in every client configuration.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `NOWEN_URL` | Nowen Note server URL | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token; preferred over username/password | — |
| `NOWEN_USERNAME` | Legacy username authentication | `admin` |
| `NOWEN_PASSWORD` | Legacy password authentication | `admin123` |
| `ALLOWED_NOTEBOOK_IDS` | Additional comma-separated local notebook allowlist; an explicit empty value denies all | disabled |
| `MCP_ACCESS_MODE` | `read-only` or `read-write` | `read-write` |
| `MCP_INCLUDE_DESCENDANTS` | Include descendants of locally allowed notebooks | `false` |
| `NOWEN_MCP_HEARTBEAT_MS` | Optional stderr heartbeat interval in milliseconds; 0/off disables it | `0` |

Authentication priority:

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

New installations should use a token.

## Permission model

The effective server permission is:

```text
Token scopes ∩ Token notebook grants ∩ current team membership ∩ resource ACL ∩ MCP service write switch
```

You can add an MCP-side allowlist as a second layer:

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": ["/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx",
        "ALLOWED_NOTEBOOK_IDS": "notebook-id-1,notebook-id-2",
        "MCP_ACCESS_MODE": "read-only",
        "MCP_INCLUDE_DESCENDANTS": "true"
      }
    }
  }
}
```

See [MCP token notebook resource scopes](./mcp-token-resource-scope.md) for the detailed design.

## Team spaces (v1.6.0)

You can authorize team notebooks you have access to, so the AI assistant can read, search, create and edit notes in them. Team notebooks are never authorized by default; you must select them yourself.

### Authorize a team space

1. Open **Settings → Connect AI Agents** and choose the assistant.
2. Under **Choose the notes the AI assistant can access**, **Personal space** is fully selected by default. **Team spaces** lists each team's notebooks, collapsed and unselected. Expand a team and select notebooks, or select the team name to pick all of its notebooks at once.
3. Click **Connect**. Nowen creates a restricted token, stores the selected notebooks and verifies the connection by calling `nowen_list_notebooks`. If creation or verification fails, an error is shown and the panel never reports “Ready”.

When a team notebook is selected, the panel warns: “The AI assistant will be able to access the team notes you selected. Make sure your team allows this assistant to access them.”

### Read-only or read-write

- Each notebook shows **Can edit** or **Read-only**, based on your current team role and the folder's permissions.
- Team owners, admins and editors can grant read-write access. Commenters and viewers can only grant read-only access; the server rejects write grants from read-only members.
- If every selected notebook is read-only, the panel shows **Read-only connection**. The token does not request write scope and the AI can only read.
- For advanced settings, such as read-only access to an editable notebook, automatically including child notebooks or folder-structure writes (`notebooks:write`), create or edit a token under **Settings → Security → Developer access tokens** (开发者访问令牌). Quick connect never grants folder-structure writes.

### How permissions are evaluated

- Team membership and role are checked again on **every request**, not only when the token is created.
- System administrator status, the workspace owner field, the note author field and direct notebook sharing never replace team membership.
- Legacy `unrestricted` tokens do not gain new capabilities, such as team folder writes, from this upgrade. Team grants apply only to restricted tokens on which team notebooks were explicitly selected.
- Tokens cannot manage team members, roles, invitations, sharing or server settings, and cannot create, widen or modify their own grants.

### How membership changes affect a token

| Change | Effect from the next request |
|---|---|
| Removed from the team | The team's notebooks disappear from notebook lists, note lists, search and the knowledge tree; reads and writes are denied. Personal grants keep working |
| Downgraded to viewer or commenter | Reads only; every write is denied, even if the token stores a write grant |
| Rejoined or promoted | The original grant applies again under the new role, never above the level originally granted |
| Notebook deleted or removed from the grant | Access is denied immediately |
| Token revoked, expired or deleted | HTTP 401 immediately; configured AI clients stop working |

### How MCP tools identify spaces

- `nowen_list_notebooks` returns `notebookId`, `notebookName`, `workspaceId` (`personal` for your personal space, the workspace ID for a team, `null` for notebooks shared with you by another user), `workspaceName`, `permission` (`read` or `write`), `parentId` and `noteCount`. Personal and team notebooks can share a name; use `notebookId` and `workspaceId` to tell them apart.
- `nowen_list_notes` and `nowen_search` stay within authorized notebooks when no space is given. The optional `workspaceId` narrows them to one space. Existing calls keep working.
- `nowen_get_knowledge_tree` may omit `workspaceId` when the connection covers a single space. When it covers several, the tool lists the available spaces and asks for an explicit choice.
- The folder tools (`nowen_preview_knowledge_tree_change`, `nowen_apply_knowledge_tree_change`) need `workspaceId` for team folders and still require a preview, version preconditions and a confirmation word. Cross-space moves are rejected. In a team, moving and trashing are limited to team administrators by default.
- Task, automation, personal drive and migration tools remain personal-space only.

### When the AI cannot access team notes

1. Check that the team notebook is selected in **Connect AI Agents** or on the developer token page. Child notebooks must be selected separately, or enable automatic inclusion of child notebooks on the developer token page.
2. Check that you are still a member of the team. Writing requires the editor role or higher.
3. Ask the AI to call `nowen_list_notebooks` and check the notebook's `workspaceId` and `permission`.
4. Documents created directly at a team's root do not belong to a notebook and cannot be authorized yet. Move them into a team notebook first.
5. `MCP_TREE_VERSION_CONFLICT` on a folder operation: preview again. If the folder contains unauthorized subfolders, authorize them as well.
6. `API_TOKEN_CROSS_SPACE_DENIED`: the AI tried to create or move content across spaces. Work within one space.
7. Administrators can review `api_token_request` audit events, which record the token ID, operation, affected spaces (`spaces`) and result (`allowed`, `failed` or `denied`).

### Revocation and security

- Click **Disconnect** under **Your assistants**, or revoke the token on the developer token page. Both take effect immediately.
- Team administrators can remove a member or lower the member's role to withdraw that member's token access to the team immediately.
- Audit logs never contain token secrets, query text or note bodies.

## Troubleshooting

### `node` is not found

Check `node --version` in the environment used by the GUI client. If necessary, set `command` to the absolute Node executable path.

Windows:

```powershell
(Get-Command node).Source
```

macOS / Linux:

```bash
which node
```

### `bin/nowen-mcp.mjs` is missing

```bash
cd packages/nowen-mcp
npm install
npm run build
```

Confirm that the client configuration uses the absolute path.

### Connection failure

- Same computer: `http://localhost:3001`
- NAS or server: `http://<LAN-IP>:3001`
- Reverse proxy: the full HTTPS origin, such as `https://note.example.com`

Open the URL in a browser on the client computer first.

### HTTP 401 or 403

- 401 usually means an invalid, expired, or revoked token.
- 403 means user ACLs, token scopes, notebook grants, or the local MCP allowlist denied access.

Do not replace a restricted token with an administrator password merely to bypass a 403.

### Reads work but writes fail

All of the following must allow writing:

- the user account's notebook permission;
- a write scope such as `notes:write`;
- read-write access for that notebook in the token resource grants;
- `MCP_ACCESS_MODE` must not be `read-only`.

### Tools do not appear

1. Run `npm run build` again.
2. Fully restart the client.
3. Restart the MCP server from the client.
4. In VS Code, run `MCP: Reset Cached Tools`.
5. Inspect logs for Node, path, network, or authentication errors.

### Running the script shows no output

A stdio MCP server normally waits for client input and can remain silent:

```bash
node /absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs
```

If it stays running without crashing, the script can start. Press `Ctrl+C` to stop it.

## Personal tasks, deadlines and reminders

`tasks:read` permits task queries and `nowen_list_task_reminders`. `tasks:write` permits task/subtask creation, updates, completion and `nowen_create_task_reminder`. Both restricted and unrestricted tokens can access only their owner's personal tasks; shared workspace tasks and global reminder delivery endpoints remain unavailable.

Create a task with `nowen_create_task` or `nowen_create_subtask`, supplying `dueDate: "2026-10-21"` and optionally `dueAt: "2026-10-21T09:30"`. Then call `nowen_create_task_reminder` with its task ID, `offsetMinutes: 30` and `timezoneOffsetMinutes: -480` for a UTC+8 user. The offset follows JavaScript `getTimezoneOffset()` and should reflect the deadline's timezone. The two writes return separate results: if reminder creation fails, retain the task and retry only the reminder. Device notification permission is still required.

Task and note results label database UTC metadata such as `createdAt` and `updatedAt` with `Z`: `01:30Z` is `09:30` in UTC+8. `dueDate` and `dueAt` retain local calendar semantics without UTC conversion. `nowen_update_task` accepts a new `dueAt` or `null` to clear the time.

## Security

- Run local MCP code only from trusted sources.
- Never commit a token-bearing MCP configuration to a public repository.
- Validate the connection with a read-only token first.
- Use separate tokens per agent for revocation and auditing.
- Use HTTPS, strong passwords, backups, and restricted CORS for internet-facing deployments.

## Related documentation

- [MCP token notebook resource scopes](./mcp-token-resource-scope.md)
- [OpenAPI guide](./api.md)
- [SDK guide](./sdk.md)
- [CLI guide](./cli.md)
