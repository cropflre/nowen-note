# MCP Server installation and usage

> Connect Claude Code, Cursor, VS Code, and other MCP clients to Nowen Note so they can search, read, and maintain notes within the permissions you grant.

[Back to tutorials](./README.md) · [简体中文](./mcp.md) · [Package README](../../packages/nowen-mcp/README.md)

## What you need to know

- MCP support is still available under `packages/nowen-mcp/`.
- The repository currently provides a **source installation**. Install Node.js 20+, Git, and npm first.
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

Current Claude Desktop versions prefer Desktop Extensions (DXT) under Settings → Extensions. Nowen Note currently ships the source-based stdio server, so use the local developer MCP entry exposed by your client version. A local stdio script cannot be added as a remote Claude connector; remote MCP requires a separate HTTP transport and authentication implementation.

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
User ACL ∩ Token scopes ∩ Token notebook resource grants
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
