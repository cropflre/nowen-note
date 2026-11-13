/** Embedded transport: all identity and permissions belong to this request. */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NowenApiClient } from "./api-client.js";
import { createNowenMcpServer } from "./index.js";

export async function handleEmbeddedMcp(request: Request, options: {
  apiToken: string;
  fetch: typeof globalThis.fetch;
  allowWrite: boolean;
  restricted: boolean;
  parsedBody: unknown;
}): Promise<Response> {
  // Deliberately do not import scoped-fetch: it patches process-global fetch
  // for standalone stdio instances. The backend enforces PAT grants here.
  const api = new NowenApiClient({
    baseUrl: "http://localhost", username: "", password: "",
    apiToken: options.apiToken, fetch: options.fetch,
    runtime: {
      transport: "streamable-http", accessMode: options.allowWrite ? "read-write" : "read-only",
      notebookScopeConfigured: options.restricted, includeDescendants: false, dangerousToolsEnabled: false,
    },
  });
  const server = createNowenMcpServer({ transport: "streamable-http", api });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: options.parsedBody });
  } finally {
    await server.close();
  }
}
