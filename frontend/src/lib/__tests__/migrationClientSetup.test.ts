import { describe, expect, it, vi } from "vitest";
import { buildMigrationClientConfig, MIGRATION_CLIENTS, validateMigrationClientSetup, type MigrationClientSetupOptions } from "../migrationClientSetup";

const local: MigrationClientSetupOptions = {
  client: "codex", transport: "stdio", apiUrl: "https://notes.example.test/api/",
  launcherPath: "/Applications/Nowen Note/packages/nowen-mcp/bin/nowen-mcp.mjs", notebookId: "target-book",
};
const issueCodes = (options: MigrationClientSetupOptions) => validateMigrationClientSetup(options).map((issue) => issue.code);

describe("migration client configuration", () => {
  it("produces Codex TOML with an inherited credential and narrowly scoped write settings", () => {
    const result = buildMigrationClientConfig(local);
    expect(result.format).toBe("toml"); expect(result.template).toBe(false);
    expect(result.content).toContain("[mcp_servers.nowen-note]");
    expect(result.content).toContain('env_vars = ["NOWEN_API_TOKEN"]');
    expect(result.content).toContain('NOWEN_URL = "https://notes.example.test"');
    expect(result.content).toContain('ALLOWED_NOTEBOOK_IDS = "target-book"');
    expect(result.content).toContain('MCP_INCLUDE_DESCENDANTS = "true"');
    expect(result.content).toContain('MCP_ACCESS_MODE = "read-write"');
    expect(result.content).not.toMatch(/^NOWEN_API_TOKEN\s*=/m);
    expect(buildMigrationClientConfig({ ...local, apiUrl: "https://notes.example.test/nowen/api/" }).content).toContain('NOWEN_URL = "https://notes.example.test/nowen"');
  });

  it("keeps HTTP gateway authentication separate from the upstream API token", () => {
    const options: MigrationClientSetupOptions = { ...local, transport: "http", endpoint: "https://mcp.example.test/mcp", launcherPath: "", notebookId: "" };
    const codex = buildMigrationClientConfig(options);
    expect(codex.content).toContain('bearer_token_env_var = "NOWEN_MCP_HTTP_TOKEN"');
    expect(codex.content).not.toContain("NOWEN_API_TOKEN");
    const claude = buildMigrationClientConfig({ ...options, client: "claude-code" });
    const server = JSON.parse(claude.content).mcpServers["nowen-note"];
    expect(server).toEqual({ type: "http", url: options.endpoint, headers: { Authorization: "Bearer ${NOWEN_MCP_HTTP_TOKEN}" } });
    expect(issueCodes(options)).toEqual(["http-gateway-unverified", "http-no-local-files"]);
  });

  it("uses Claude variable expansion but fixed credential placeholders for unproven expansion formats", () => {
    const claude = JSON.parse(buildMigrationClientConfig({ ...local, client: "claude-code" }).content).mcpServers["nowen-note"];
    expect(claude.env.NOWEN_API_TOKEN).toBe("${NOWEN_API_TOKEN}");
    for (const client of ["workbuddy", "qoder", "doubao-work", "other"] as const) {
      const result = buildMigrationClientConfig({ ...local, client });
      const server = JSON.parse(result.content).mcpServers["nowen-note"];
      expect(server.env.NOWEN_API_TOKEN).toMatch(/^<replace-/);
      expect(server.env.ALLOWED_NOTEBOOK_IDS).toBe("target-book");
      expect(server.env.MCP_INCLUDE_DESCENDANTS).toBe("true");
      expect(result.template).toBe(["doubao-work", "other"].includes(client));
    }
  });

  it("marks unverified HTTP schemas as templates and never calls the network", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      for (const client of ["workbuddy", "qoder", "doubao-work", "other"] as const) {
        const options: MigrationClientSetupOptions = { ...local, client, transport: "http", endpoint: "https://mcp.example.test/mcp" };
        expect(buildMigrationClientConfig(options).template).toBe(true);
        expect(issueCodes(options)).toContain("client-template");
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(MIGRATION_CLIENTS.every((client) => client.hostVerified === false)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects credential-bearing URLs without including the credential in the error", () => {
    for (const url of ["https://user:secret@example.test", "https://notes.example.test?token=secret", "https://notes.example.test/#secret", "https://notes.example.test/?", "https://notes.example.test/#", "javascript:secret", "https://notes.example.test/\nsecret"]) {
      expect(issueCodes({ ...local, apiUrl: url })).toContain("api-url-invalid");
      expect(() => buildMigrationClientConfig({ ...local, apiUrl: url })).toThrow(/^api-url-invalid$/);
      expect(() => buildMigrationClientConfig({ ...local, transport: "http", endpoint: url })).toThrow(/^endpoint-invalid$/);
    }
  });

  it("requires concrete notebook scope and an absolute stdio launcher without control characters", () => {
    for (const notebookId of ["", "*", "one,two", "target\nOTHER=scope", " target "]) {
      const options = { ...local, notebookId };
      expect(validateMigrationClientSetup(options).some((issue) => issue.code.startsWith("target-") && issue.severity === "error")).toBe(true);
      expect(() => buildMigrationClientConfig(options)).toThrow(/^target-/);
    }
    for (const launcherPath of ["", "./nowen-mcp.mjs", "node ./nowen-mcp.mjs", "/path\n--eval=bad"]) {
      const options = { ...local, launcherPath };
      expect(validateMigrationClientSetup(options).some((issue) => issue.code.startsWith("launcher-") && issue.severity === "error")).toBe(true);
      expect(() => buildMigrationClientConfig(options)).toThrow(/^launcher-/);
    }
    const windows = buildMigrationClientConfig({ ...local, launcherPath: "C:\\Nowen Note\\nowen-mcp.mjs" });
    expect(windows.content).toContain('args = ["C:\\\\Nowen Note\\\\nowen-mcp.mjs"]');
  });

  it("requires HTTPS for non-loopback MCP gateways and reports unverified local runtime separately", () => {
    expect(issueCodes(local)).toContain("stdio-runtime-unverified");
    expect(issueCodes({ ...local, apiUrl: "http://nas.local:3001" })).toContain("api-url-insecure");
    expect(() => buildMigrationClientConfig({ ...local, transport: "http", endpoint: "http://nas.local:4318/mcp" })).toThrow("endpoint-insecure");
    expect(() => buildMigrationClientConfig({ ...local, transport: "http", endpoint: "" })).toThrow("endpoint-required");
    for (const endpoint of ["http://localhost:4318/mcp", "http://127.0.0.1:4318/mcp", "http://[::1]:4318/mcp"]) {
      expect(() => buildMigrationClientConfig({ ...local, transport: "http", endpoint })).not.toThrow();
    }
  });
});
