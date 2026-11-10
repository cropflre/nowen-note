import { Hono } from "hono";
import { getDb } from "../db/schema";
import { claimOnboardingWelcome } from "../lib/onboarding";

const app = new Hono();

app.post("/welcome", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ noteId: claimOnboardingWelcome(getDb(), userId) });
});

export default app;
