import { Hono } from "hono";
import syncRoutes from "./user-preferences-sync";
import legacyRoutes from "./user-preferences-legacy";
import reliableAIRoutes from "./ai-reliable";
import mobileBootstrapRoutes from "./mobile-bootstrap";

/**
 * Compatibility wrapper: existing user preference/profile endpoints stay at their
 * original paths, while reliability/startup pipelines are isolated under explicit
 * sub-paths so older clients remain untouched.
 */
const app = new Hono();

// Root preference GET/PUT/PATCH must be mounted before the legacy router. The new
// implementation keeps the old flat response fields while adding account-scoped
// revision metadata and field-level merge semantics.
app.route("/", syncRoutes);
app.route("/mobile-bootstrap", mobileBootstrapRoutes);
app.route("/ai-reliable", reliableAIRoutes);
app.route("/", legacyRoutes);

export default app;
