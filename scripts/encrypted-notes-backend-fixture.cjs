// Applied only to the production backend child, not the Electron main process.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Server } = require("node:net");
const directory = path.resolve(process.env.NOWEN_ENCRYPTED_APP_PROFILE || "");
if (process.env.ELECTRON_RUN_AS_NODE !== "1" || path.dirname(directory) !== path.resolve(os.tmpdir())
  || !path.basename(directory).startsWith("nowen-encrypted-app-")) throw new Error("An isolated embedded backend is required");
const working = path.join(directory, "backend");
fs.mkdirSync(working, { recursive: true });
process.chdir(working);
// Keep production bundle, auth and database paths; constrain only this test listener.
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  args[1] = "127.0.0.1";
  return Reflect.apply(listen, this, args);
};
