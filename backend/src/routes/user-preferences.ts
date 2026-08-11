import { Hono } from "hono";
import syncRoutes from "./user-preferences-sync";
import legacyRoutes from "./user-preferences-legacy";
import reliableAIRoutes from "./ai-reliable";
import mobileBootstrapRoutes from "./mobile-bootstrap";
import taskDayPlansRoutes from "./task-day-plans";
import taskMetadataRoutes from "./task-metadata";
import taskTimeBlocksRoutes from "./task-time-blocks";
import taskInboxRoutes from "./task-inbox";

/**
 * Compatibility wrapper: existing user preference/profile endpoints stay at their
 * original paths, while reliability/startup pipelines are isolated under explicit
 * sub-paths so older clients remain untouched.
 */
const app = new Hono();

// Task day plans are user-scoped planning state, not task deadlines. Keep them
// under user-preferences so the feature can sync across devices without changing
// the core tasks table or the semantics of the existing "Today" due-date filter.
app.route("/task-day-plans", taskDayPlansRoutes);

// Labels and saved views are task organization metadata. Labels may be shared in
// a workspace, while each saved view remains account-scoped.
app.route("/task-metadata", taskMetadataRoutes);

// Time blocks are personal calendar allocations. Even inside a shared workspace,
// every member owns an independent schedule for the same shared task.
app.route("/task-time-blocks", taskTimeBlocksRoutes);

// Inbox membership is personal processing state. A shared task can therefore be
// captured by multiple members without changing the shared task record itself.
app.route("/task-inbox", taskInboxRoutes);

// Root preference GET/PUT/PATCH must be mounted before the legacy router. The new
// implementation keeps the old flat response fields while adding account-scoped
// revision metadata and field-level merge semantics.
app.route("/", syncRoutes);
app.route("/mobile-bootstrap", mobileBootstrapRoutes);
app.route("/ai-reliable", reliableAIRoutes);
app.route("/", legacyRoutes);

export default app;