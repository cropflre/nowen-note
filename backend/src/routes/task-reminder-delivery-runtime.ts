import { Hono } from "hono";

import type { TaskAutomationDeliveryRuntime } from "../services/task-automation-delivery-runtime";
import type { TaskReminderDeliveryRuntime } from "../services/task-reminder-delivery-runtime";

export function createTaskReminderDeliveryRuntimeRouter(
  runtime: TaskReminderDeliveryRuntime,
  automationRuntime?: TaskAutomationDeliveryRuntime,
) {
  const app = new Hono();

  app.get("/recent", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const rawSince = Number(c.req.query("since") || "0");
    const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
    const [reminders, automation] = await Promise.all([
      runtime.listRecent(userId, since),
      automationRuntime ? automationRuntime.listRecent(userId, since) : Promise.resolve([]),
    ]);
    return c.json({
      reminders: [...reminders, ...automation]
        .sort((a, b) => a.triggeredAt - b.triggeredAt)
        .slice(0, 200),
    });
  });

  app.post("/recent/ack", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const reminderIds = Array.isArray(body.reminderIds)
      ? body.reminderIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 200)
      : [];
    if (reminderIds.length === 0) return c.json({ success: true, acked: 0 });
    const [reminderAcked, automationAcked] = await Promise.all([
      runtime.acknowledge(userId, reminderIds),
      automationRuntime ? automationRuntime.acknowledge(userId, reminderIds) : Promise.resolve(0),
    ]);
    return c.json({ success: true, acked: reminderAcked + automationAcked });
  });

  return app;
}

export default createTaskReminderDeliveryRuntimeRouter;
