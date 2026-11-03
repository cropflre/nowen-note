import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t, validChecksum = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-fetch-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../fetch-node.mjs", import.meta.url), path.join(root, "scripts/fetch-node.mjs"));
  const platform = process.platform === "darwin" ? `darwin-${process.arch}` : "linux-x64";
  const filename = `node-v24.22.1-${platform}.tar.gz`;
  const entry = `node-v24.22.1-${platform}/bin/node`;
  const source = path.join(root, "archive", entry);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "patched runtime");
  const archive = path.join(root, filename);
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", path.join(root, "archive"), entry]).status, 0);
  const hash = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(path.join(root, "SHASUMS256.txt"), `${validChecksum ? hash : "0".repeat(64)}  ${filename}\n`);
  const node = path.join(root, "electron/node", platform, "node");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, "old runtime");
  fs.writeFileSync(`${node}.version`, "v20.18.0\n");
  // Supply official-download-shaped responses without making network requests.
  const mock = path.join(root, "mock.cjs");
  fs.writeFileSync(mock, `
    const fs = require('node:fs'), path = require('node:path');
    const { Readable } = require('node:stream');
    const { EventEmitter } = require('node:events');
    require('node:https').get = (url, callback) => {
      const request = new EventEmitter();
      setImmediate(() => {
        const name = path.basename(new URL(url).pathname);
        fs.appendFileSync(path.join(__dirname, 'requests'), name + '\\n');
        callback(Object.assign(Readable.from([fs.readFileSync(path.join(__dirname, name))]), { statusCode: 200 }));
      });
      return request;
    };
  `);
  return {
    node,
    root,
    run: () => spawnSync(process.execPath, ["--require", mock, path.join(root, "scripts/fetch-node.mjs")], {
      encoding: "utf8",
      env: { ...process.env, NODE_EMBED_VERSION: "v24.22.1", NODE_MIRROR: "https://node.invalid/dist" },
    }),
  };
}

test("replaces an outdated cached Node binary and reuses the requested version", {
  skip: process.platform === "win32",
}, t => {
  const target = fixture(t);
  const result = target.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target.node, "utf8"), "patched runtime");
  assert.equal(fs.readFileSync(`${target.node}.version`, "utf8"), "v24.22.1\n");
  const requests = fs.readFileSync(path.join(target.root, "requests"), "utf8");
  assert.equal(target.run().status, 0);
  assert.equal(fs.readFileSync(path.join(target.root, "requests"), "utf8"), requests);
});

test("rejects a bad download checksum and preserves the existing Node binary", {
  skip: process.platform === "win32",
}, t => {
  const target = fixture(t, false);
  const result = target.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(fs.readFileSync(target.node, "utf8"), "old runtime");
  assert.equal(fs.readFileSync(`${target.node}.version`, "utf8"), "v20.18.0\n");
});
