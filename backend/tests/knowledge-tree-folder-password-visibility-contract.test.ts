import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const noteGuard = readFileSync(new URL("../src/middleware/knowledgeCapabilityGuard.ts", import.meta.url), "utf8");
const searchGuard = readFileSync(new URL("../src/middleware/knowledgeSearchCapabilityGuard.ts", import.meta.url), "utf8");
const frontendApi = readFileSync(new URL("../../frontend/src/lib/api.impl.ts", import.meta.url), "utf8");

test("folder password visibility is enforced by note and search guards", () => {
  assert.match(noteGuard, /canViewNoteThroughFolderPasswords/);
  assert.match(searchGuard, /canViewNoteThroughFolderPasswords/);
});

test("frontend authenticated requests carry current folder unlock tokens", () => {
  const buildHeadersStart = frontendApi.indexOf("const buildHeaders");
  const nativeFallbackStart = frontendApi.indexOf("const tryNativeFallback", buildHeadersStart);
  assert.notEqual(buildHeadersStart, -1);
  assert.notEqual(nativeFallbackStart, -1);
  assert.match(
    frontendApi.slice(buildHeadersStart, nativeFallbackStart),
    /\.\.\.folderUnlockRequestHeaders\(\)/,
  );
});
