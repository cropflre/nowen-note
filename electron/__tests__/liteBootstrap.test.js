const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("packaged Lite loads the main process imports without Native Messaging resources", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const end = source.indexOf("\ninitLogger(");
  assert.ok(end > 0);
  const resourcesPath = path.resolve("lite-resources");
  const clipperPath = path.join(resourcesPath, "clipper", "clipper-host.js");

  vm.runInNewContext(source.slice(0, end), {
    process: { resourcesPath },
    require(id) {
      if (id === "electron") return { app: { isPackaged: true } };
      if (id === "path") return path;
      if (id === clipperPath) throw new Error(`Cannot find module '${id}'`);
      return {};
    },
  });
});
