// Full production routes/auth/runtime, with all filesystem output in a private directory.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Server } from "node:net";
const directory = path.resolve(process.env.NOWEN_ENCRYPTED_APP_PROFILE || "");
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("nowen-encrypted-app-")) {
  throw new Error("An isolated temporary backend directory is required");
}
const data = path.join(directory, "backend");
fs.mkdirSync(data, { recursive: true });
process.chdir(data);
process.env.DB_PATH = path.join(data, "test.db");
process.env.ELECTRON_USER_DATA = data;
process.env.BACKUP_DIR = path.join(data, "backups");
process.env.JWT_SECRET = "test-only-encrypted-app-session-secret";
process.env.NODE_ENV = "test";
process.env.DISABLE_MDNS = "1";
process.env.BACKUP_AUTO_ENABLED = "false";
process.env.CALENDAR_EXPORT_TIMER_DISABLED = "1";
// index.ts's serve() otherwise listens on all interfaces. Limit this private process.
const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  args[1] = "127.0.0.1";
  return Reflect.apply(listen, this, args);
} as typeof listen;
void import("../src/index.hardened.js");
