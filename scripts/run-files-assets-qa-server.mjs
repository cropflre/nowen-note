import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Development checkouts may carry Electron ABI SQLite. Probe an in-memory DB;
// use the matching bundled runtime without rebuilding the user's dependencies.
const require = createRequire(import.meta.url);
let runtime = process.execPath;
let env = process.env;
try {
  const Database = require(path.join(root, "backend/node_modules/better-sqlite3"));
  new Database(":memory:").close();
} catch (error) {
  if (!/NODE_MODULE_VERSION/.test(String(error))) throw error;
  runtime = require("electron");
  env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}
const child = spawn(runtime, ["--import", "tsx", "scripts/files-assets-qa-server.mjs"], {
  cwd: path.join(root, "backend"), env, stdio: "inherit", windowsHide: true,
});
child.on("exit", (code) => { process.exitCode = code || 0; });
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
