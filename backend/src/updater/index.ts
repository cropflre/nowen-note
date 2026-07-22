import crypto from "crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createUpdateJob,
  getJob,
  getUpdaterStatus,
  requestJobCancellation,
  runUpdaterPreflight,
} from "./jobs";

const port = Math.max(1, Number(process.env.NOWEN_UPDATER_PORT) || 3002);
const token = (process.env.NOWEN_UPDATER_TOKEN || "").trim();

if (token.length < 32) {
  console.error("[updater] NOWEN_UPDATER_TOKEN must contain at least 32 characters");
  process.exit(1);
}

const app = new Hono();
const requestWindow = new Map<string, { count: number; resetAt: number }>();

function constantTimeTokenMatch(candidate: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(token, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

app.get("/health", (c) => c.json({ status: "ok", service: "nowen-note-updater" }));

app.use("/v1/*", async (c, next) => {
  const remote = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "internal";
  const now = Date.now();
  const entry = requestWindow.get(remote);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
    if (entry.count > 120) return c.json({ error: "请求过于频繁" }, 429);
  } else {
    requestWindow.set(remote, { count: 1, resetAt: now + 60_000 });
  }

  const authorization = c.req.header("authorization") || "";
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!candidate || !constantTimeTokenMatch(candidate)) {
    return c.json({ error: "更新代理认证失败" }, 401);
  }
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/v1/status", async (c) => {
  try {
    return c.json(await getUpdaterStatus());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
  }
});

app.post("/v1/preflight", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { targetVersion?: string };
  try {
    const result = await runUpdaterPreflight(body.targetVersion);
    return c.json(result, result.ok ? 200 : 409);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.post("/v1/jobs", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    targetVersion?: string;
    targetImageId?: string;
    expectedCurrentImageId?: string;
    backup?: { filename: string; size: number; checksum: string; schemaVersion?: number | null };
  };
  if (!body.targetVersion || !body.targetImageId || !body.expectedCurrentImageId) {
    return c.json({ error: "缺少经过预检的目标版本或镜像标识" }, 400);
  }
  try {
    const job = await createUpdateJob({
      targetVersion: body.targetVersion,
      targetImageId: body.targetImageId,
      expectedCurrentImageId: body.expectedCurrentImageId,
      backup: body.backup,
    });
    return c.json(job, 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

app.get("/v1/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  return job ? c.json(job) : c.json({ error: "更新任务不存在" }, 404);
});

app.post("/v1/jobs/:id/cancel", (c) => {
  try {
    return c.json(requestJobCancellation(c.req.param("id")));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

app.onError((error, c) => {
  console.error("[updater] unhandled request error:", error);
  return c.json({ error: "更新代理内部错误" }, 500);
});

serve({ fetch: app.fetch, port });
console.log(`[updater] control plane listening on port ${port}; Docker socket is not exposed to the application container`);
