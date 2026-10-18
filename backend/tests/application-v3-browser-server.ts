// Disposable 1.5.3 host using production version checks and defaults. Not a product entrypoint.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Server } from "node:net";

const directory = path.resolve(process.env.V3_BROWSER_PROFILE || "");
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("nowen-v3-browser-")) throw new Error("An isolated V3 profile is required");
const data = path.join(directory, "backend"); fs.mkdirSync(data, { recursive: true }); process.chdir(data);
process.env.DB_PATH = path.join(data, "test.db"); process.env.ELECTRON_USER_DATA = data;
process.env.JWT_SECRET = "v3-browser-only-test-session-secret"; process.env.BACKUP_DIR = path.join(data, "backups");
process.env.DISABLE_MDNS = "1"; process.env.BACKUP_AUTO_ENABLED = "false"; process.env.CALENDAR_EXPORT_TIMER_DISABLED = "1";
process.env.NODE_ENV = "test";
async function start() {
  const { V3_GATES } = await import("./application-v3-fixture.js");
  V3_GATES.forEach(key => delete process.env[key]);
  const { getDb } = await import("../src/db/schema.js");
  const { default: bcrypt } = await import("bcryptjs");
  getDb().prepare("INSERT OR IGNORE INTO users(id,username,passwordHash,role) VALUES ('v3-browser-admin','v3_browser',?,'admin')").run(await bcrypt.hash("v3-browser-test-password", 10));
  // Serve the same production frontend and authentication routes, with a disposable DB only.
  process.env.NODE_ENV = "production";
  const listen = Server.prototype.listen;
  Server.prototype.listen = function(this: Server, ...args: unknown[]) { args[1] = "127.0.0.1"; return Reflect.apply(listen, this, args); } as typeof listen;
  await import("../src/index.hardened.js");
}
void start();
