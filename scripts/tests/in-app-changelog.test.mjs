import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateInAppChangelog, verifyInAppChangelog } from "../verify-in-app-changelog.mjs";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const good = JSON.parse(readFileSync(new URL("../../docs/releases/in-app-changelog.json", import.meta.url), "utf8"));

test("release notes are curated, current, correctly ordered, and match public asset", () => {
  assert.equal(verifyInAppChangelog().version, version);
  assert.equal(good.entries[0].version, version);
  assert.equal(good.entries[1].version, "1.5.4");
  assert.equal(good.entries[2].version, "1.5.3");
  assert.doesNotMatch(good.entries.map(x => x.body).join("\n"), /studio:.*\([a-f0-9]{7}\)/i);
});

test("missing current version blocks release packaging", () => {
  assert.throws(() => validateInAppChangelog({ ...good, entries: good.entries.slice(1) }, version), /stale/);
});

test("raw commit history, oversized notes, and duplicate or unordered versions are rejected", () => {
  assert.throws(() => validateInAppChangelog({
    ...good, entries: [{ ...good.entries[0], body: good.entries[0].body + " (a1b2c3d)" }, ...good.entries.slice(1)],
  }, version), /Raw commit/);
  assert.throws(() => validateInAppChangelog({
    ...good, entries: [{ ...good.entries[0], body: good.entries[0].body + "X".repeat(4500) }, ...good.entries.slice(1)],
  }, version), /excessively long/);
  assert.throws(() => validateInAppChangelog({
    ...good, entries: [...good.entries.slice(0, 2), good.entries[1]],
  }, version), /unique and strictly newest/);
});

test("malformed dates and absent release summaries are rejected", () => {
  assert.throws(() => validateInAppChangelog({
    ...good, entries: [{ ...good.entries[0], date: "2026-02-30" }, ...good.entries.slice(1)],
  }, version), /Invalid release date/);
  assert.throws(() => validateInAppChangelog({
    ...good, entries: [{ ...good.entries[0], body: "short" }, ...good.entries.slice(1)],
  }, version), /Missing or excessively long/);
});
