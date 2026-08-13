import { Hono } from "hono";

import type { TaskReminderDeliveryRuntime } from "../services/task-reminder-delivery-runtime";

export function createTaskReminderDeliveryRuntimeRouter(runtime: TaskReminderDeliveryRuntime) {
  const app = new Hono();

  app.get("/recent", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const rawSince = Number(c.req.query("since") || "0");
    const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
    const reminders = await runtime.listRecent(userId, since);
    return c.json({ reminders });
  });

  app.post("/recent/ack", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const reminderIds = Array.isArray(body.reminderIds)
      ? body.reminderIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 200)
      : [];
    if (reminderIds.length === 0) return c.json({ success: true, acked: 0 });
    const acked = await runtime.acknowledge(userId, reminderIds);
    return c.json({ success: true, acked });
  });

  return app;
}

export default createTaskReminderDeliveryRuntimeRouter;
