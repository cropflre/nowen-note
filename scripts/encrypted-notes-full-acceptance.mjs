// macOS Full package acceptance; never signs, publishes, or uses the user's profile.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("This package acceptance currently requires a macOS graphical desktop");
}
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run("npm", ["run", "build:all"]);
run(process.execPath, ["node_modules/electron-builder/cli.js", "--config", "scripts/encrypted-notes-package-fixture.cjs", "--mac", "--dir", `--${process.arch}`, "--publish", "never"], root, {
  ...process.env, NOWEN_MAC_ARCH: process.arch, CSC_IDENTITY_AUTO_DISCOVERY: "false",
});
const executable = path.join(root, "frontend/node_modules/.cache/encrypted-notes-packaged", `mac${process.arch === "arm64" ? "-arm64" : ""}`, "Nowen Note.app/Contents/MacOS/Nowen Note");
run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.encrypted-notes-full.config.ts"], path.join(root, "frontend"), {
  ...process.env, NOWEN_ENCRYPTED_PACKAGED_EXECUTABLE: executable,
});
