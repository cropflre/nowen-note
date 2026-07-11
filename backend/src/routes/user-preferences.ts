import { Hono } from "hono";
import legacyRoutes from "./user-preferences-legacy";
import reliableAIRoutes from "./ai-reliable";

/**
 * Compatibility wrapper: existing user preference/profile endpoints stay at their
 * original paths, while the reliability pipeline is isolated under
 * /api/user-preferences/ai-reliable so older clients remain untouched.
 */
const app = new Hono();

app.route("/ai-reliable", reliableAIRoutes);
app.route("/", legacyRoutes);

export default app;
