import { Hono } from "hono";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { ensureMindmapSchema } from "../lib/mindmap-schema.js";
import {
  enforceKnowledgeNoteCapabilities,
  enforceKnowledgeNotebookCapabilities,
} from "../middleware/knowledgeCapabilityGuard.js";
import knowledgeTreeRouter from "../routes/knowledge-tree.js";

const INSTALL_KEY = Symbol.for("nowen.knowledgeTree.runtimeInstalled");
const ROUTE_KEY = Symbol.for("nowen.knowledgeTree.routeMounted");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

// Ensure optional resource tables/views exist before the first tree query. The file manager is
// backed by attachments; a compatibility view gives unified nodes a stable read-only title source.
const db = getDb();
ensureKnowledgeTreeTables(db);
ensureMindmapSchema(db);
const filesObject = db.prepare("SELECT type FROM sqlite_master WHERE name = 'files'").get() as { type: string } | undefined;
if (!filesObject) {
  db.exec("CREATE VIEW files AS SELECT id, filename FROM attachments");
}

if (!globals[INSTALL_KEY]) {
  globals[INSTALL_KEY] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;

  prototype.route = function knowledgeTreeRouteWrapper(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/notes") {
      const wrapper = new Hono<any>();
      wrapper.use("*", enforceKnowledgeNoteCapabilities);
      wrapper.route("/", subApp);
      return nativeRoute.call(this, path, wrapper);
    }

    if (path === "/api/notebooks") {
      const wrapper = new Hono<any>();
      wrapper.use("*", enforceKnowledgeNotebookCapabilities);
      wrapper.route("/", subApp);
      const mounted = nativeRoute.call(this, path, wrapper);
      if (!globals[ROUTE_KEY]) {
        globals[ROUTE_KEY] = true;
        nativeRoute.call(this, "/api/knowledge-tree", knowledgeTreeRouter);
      }
      return mounted;
    }

    return nativeRoute.call(this, path, subApp);
  };
}
