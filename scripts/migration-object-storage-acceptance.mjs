/** Run against an explicitly installed local S3rver; no package or container is installed implicitly. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = process.env.NOWEN_MIGRATION_S3RVER_MODULE;
if (!modulePath || !path.isAbsolute(modulePath)) throw new Error("Set NOWEN_MIGRATION_S3RVER_MODULE to an explicitly installed s3rver module's absolute path");
const require = createRequire(import.meta.url);
const S3rver = require(modulePath);
const version = require(path.join(modulePath, "package.json")).version;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-s3-daemon-"));
const server = new S3rver({ address: "127.0.0.1", port: 0, silent: true, directory,
  allowMismatchedSignatures: false, configureBuckets: [{ name: "isolated-migration-fixture" }] });
let exitCode = 1;
try {
  const address = await server.run();
  const node = process.env.NOWEN_MIGRATION_TEST_NODE || process.execPath;
  const child = spawn(node, ["--import", "tsx", "--test", "tests/migration-object-storage.integration.test.ts"], {
    cwd: path.join(root, "backend"), stdio: "inherit", env: { ...process.env,
      ...(path.basename(node).includes("electron") ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      NOWEN_MIGRATION_S3_TEST_ENDPOINT: `http://127.0.0.1:${address.port}`,
      NOWEN_MIGRATION_S3_TEST_BUCKET: "isolated-migration-fixture",
      NOWEN_MIGRATION_S3_TEST_ACCESS_KEY_ID: "S3RVER", NOWEN_MIGRATION_S3_TEST_SECRET_ACCESS_KEY: "S3RVER",
      // S3rver parses V4 headers but explicitly skips cryptographic signature calculation.
      NOWEN_MIGRATION_S3_TEST_SKIP_SECRET_SIGNATURE: "1",
      NOWEN_MIGRATION_S3_TEST_SERVER: `S3rver ${version}; allowMismatchedSignatures=false; real loopback HTTP and disk storage` },
  });
  const stop = () => child.kill("SIGTERM"); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); }); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
} finally { try { await server.close(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } }
process.exitCode = exitCode;
