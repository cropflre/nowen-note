import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import type {
  DatabaseAdapter,
  DbRunResult,
  DbStatement,
} from "../src/db/adapters/types";
import createSearchRuntimeRouter from "../src/routes/search-runtime";
import {
  buildSearchRuntimeResult,
  createSearchRuntime,
  markSearchText,
} from "../src/services/search-runtime";

class SearchAdapter implements DatabaseAdapter {
  readonly calls: Array<{ kind: string; sql: string; params: unknown[] }> = [];
  role = "admin";
  workspaceAllowed = 1;
  rows: any[] = [];

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    this.calls.push({ kind: "one", sql, params });
    if (sql.includes("information_schema.columns")) {
      return {
        columnReady: true,
        indexReady: true,
        metadataIndexesReady: true,
        noteCount: 1,
        indexedCount: 1,
      } as T;
    }
    if (sql.includes("SELECT role FROM users")) return { role: this.role } as T;
    if (sql.includes("AS allowed")) return { allowed: this.workspaceAllowed } as T;
    return undefined;
  }

  async queryMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ kind: "many", sql, params });
    return this.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    this.calls.push({ kind: "execute", sql, params });
    return { changes: 0 };
  }

  async executeBatch(): Promise<DbRunResult> {
    return { changes: 0 };
  }

  async executeStatements(_statements: DbStatement[]): Promise<{ changes: number }> {
    return { changes: 0 };
  }
}

const row = {
  id: "note-1",
  userId: "user-1",
  notebookId: "notebook-1",
  workspaceId: null,
  title: "PostgreSQL 搜索迁移",
  contentText: "正文支持 C++ 和中文检索",
  updatedAt: "2026-08-06T00:00:00.000Z",
  isFavorite: true,
  isPinned: false,
  contentFormat: "markdown",
  notebookName: "迁移",
  tagText: "database",
  attachmentNames: "plan.pdf",
  attachmentText: "全文检索验收",
  ftsRank: 0.5,
};

test("search runtime keeps legacy result shape and Unicode-safe highlights", () => {
  const result = buildSearchRuntimeResult(row, ["搜索", "C++"], "搜索 c++");
  if (!result) throw new Error("expected search result");
  assert.equal(result.id, "note-1");
  assert.equal(result.isFavorite, 1);
  assert.equal(result.isPinned, 0);
  assert.deepEqual(result.matchedFields, ["title", "content"]);
  assert.match(result.titleHtml, /<mark>搜索<\/mark>/);
  assert.match(result.snippetHtml, /<mark>搜索<\/mark>/);
  assert.equal(markSearchText("支持 C++", ["C++"]), "支持 <mark>C++</mark>");
  assert.equal(markSearchText("ＡＢＣ", ["abc"]), "<mark>ＡＢＣ</mark>");
});

test("search runtime uses tsvector ranking plus bounded literal fallback", async () => {
  const adapter = new SearchAdapter();
  adapter.rows = [row];
  const runtime = createSearchRuntime(adapter);
  const response = await runtime.search({
    userId: "user-1",
    query: "搜索 C++",
    workspaceId: "personal",
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.diagnostics.literalFallback, true);
  const query = adapter.calls.find((call) => call.kind === "many");
  if (!query) throw new Error("expected search query");
  assert.match(query.sql, /n\."searchVector" @@ plainto_tsquery/);
  assert.match(query.sql, /ts_rank_cd/);
  assert.match(query.sql, /notebook_members/);
  assert.ok(query.params.includes("%搜索%"));
  assert.ok(query.params.includes("%c++%"));
});

test("workspace search is rejected before querying notes when membership is absent", async () => {
  const adapter = new SearchAdapter();
  adapter.workspaceAllowed = 0;
  const runtime = createSearchRuntime(adapter);
  await assert.rejects(
    runtime.search({ userId: "user-1", query: "postgres", workspaceId: "workspace-1" }),
    (error: any) => error?.code === "FORBIDDEN" && error?.status === 403,
  );
  assert.equal(adapter.calls.some((call) => call.kind === "many"), false);
});

test("search route exposes health, rebuild and compatibility headers", async () => {
  const adapter = new SearchAdapter();
  adapter.rows = [row];
  const app = new Hono();
  app.route("/search", createSearchRuntimeRouter(adapter));

  const health = await app.request("/search/health", {
    headers: { "X-User-Id": "user-1" },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).engine, "postgresql-tsvector");

  const response = await app.request("/search?q=PostgreSQL&workspaceId=personal", {
    headers: { "X-User-Id": "user-1" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Search-Index-Status"), "ok");
  assert.equal(response.headers.get("X-Search-Candidate-Count"), "1");
  assert.match(response.headers.get("Server-Timing") || "", /query;dur=/);

  const rebuilt = await app.request("/search/rebuild", {
    method: "POST",
    headers: { "X-User-Id": "user-1" },
  });
  assert.equal(rebuilt.status, 200);
  assert.equal((await rebuilt.json()).success, true);
  assert.ok(adapter.calls.some((call) => call.sql === "REINDEX INDEX idx_notes_search_vector"));
});
