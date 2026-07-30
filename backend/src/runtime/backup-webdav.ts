import backupsRouter from "../routes/backups.js";
import backupWebDavRouter from "../routes/backup-webdav.js";

const PATCH_FLAG = Symbol.for("nowen.backupWebDav.routesMounted");
const router = backupsRouter as typeof backupsRouter & Record<PropertyKey, unknown>;

if (!router[PATCH_FLAG]) {
  router[PATCH_FLAG] = true;
  router.route("/webdav", backupWebDavRouter);
}
