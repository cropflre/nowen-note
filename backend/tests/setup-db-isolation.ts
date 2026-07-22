import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_KEY = Symbol.for("nowen-note.backend-test-db-isolation");
const globalState = globalThis as typeof globalThis & {
  [STATE_KEY]?: { directory: string };
};

if (!globalState[STATE_KEY]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nowen-note-test-${process.pid}-`));
  globalState[STATE_KEY] = { directory };
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(directory, "test.db");
  process.env.ELECTRON_USER_DATA = directory;

  process.once("exit", () => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Process shutdown must not hide the original test result.
    }
  });
}
