import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createSearchRuntime,
  SearchRuntimeError,
} from "../services/search-runtime";

function failure(c: Context, error: unknown): Response {
  if (error instanceof SearchRuntimeError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  console.error("[search-runtime] request failed:", error);
  return c.json({
    error: "PostgreSQL 全文搜索请求失败",
    code: "POSTGRES_SEARCH_FAILED",
  }, 500);
}

function setTimingHeaders(
  c: Context,
  diagnostics: {
    candidateCount: number;
    literalFallback: boolean;
    indexStatus: "ok" | "degraded";
    queryDurationMs: number;
    renderDurationMs: number;
    totalDurationMs: number;
  },
): void {
  c.header("X-Search-Index-Status", diagnostics.indexStatus);
  c.header("X-Search-Candidate-Count", String(diagnostics.candidateCount));
  c.header("X-Search-Literal-Fallback", diagnostics.literalFallback ? "1" : "0");
  c.header(
    "Server-Timing",
    [
      `query;dur=${diagnostics.queryDurationMs.toFixed(1)}`,
      `render;dur=${diagnostics.renderDurationMs.toFixed(1)}`,
      `total;dur=${diagnostics.totalDurationMs.toFixed(1)}`,
    ].join(", "),
  );
}

export default function createSearchRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();
  const search = createSearchRuntime(adapter);

  app.get("/health", async (c: Context) => {
    try {
      return c.json(await search.health(c.req.header("X-User-Id") || ""));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/rebuild", async (c: Context) => {
    try {
      return c.json(await search.rebuild(c.req.header("X-User-Id") || ""));
    } catch (error) {
      return failure(c, error);
    }
  });

  const executeSearch = async (c: Context) => {
    try {
      const response = await search.search({
        userId: c.req.header("X-User-Id") || "",
        query: c.req.query("q") || "",
        workspaceId: c.req.query("workspaceId"),
      });
      setTimingHeaders(c, response.diagnostics);
      return c.json(response.results);
    } catch (error) {
      return failure(c, error);
    }
  };

  app.get("", executeSearch);
  app.get("/", executeSearch);
  return app;
}
