#!/usr/bin/env node

import fs from "node:fs";

function replaceOnce(filename, before, after) {
  const source = fs.readFileSync(filename, "utf8");
  if (source.includes(after)) return false;
  if (!source.includes(before)) throw new Error(`Expected patch anchor missing in ${filename}`);
  fs.writeFileSync(filename, source.replace(before, after), "utf8");
  return true;
}

let changed = false;

changed = replaceOnce(
  "frontend/src/lib/issue210Signoff.ts",
  `  return document.querySelector<HTMLElement>(\n    '.ProseMirror[contenteditable="true"], .cm-editor:has(.cm-content[contenteditable="true"])',\n  );`,
  `  return document.querySelector<HTMLElement>(\n    '.ProseMirror[contenteditable="true"], .cm-editor',\n  );`,
) || changed;

changed = replaceOnce(
  "scripts/validate-issue-210-signoff.mjs",
  `    if (sample.instanceStable !== true) failures.push(\`${'${prefix}'} remounted the editor\`);\n    if (sample.selectionStable !== true) failures.push(\`${'${prefix}'} changed the selection\`);\n    if (!finiteNonNegative(Math.abs(sample.scrollDeltaPx))) failures.push(\`${'${prefix}'}.scrollDeltaPx is missing\`);\n    else if (Math.abs(sample.scrollDeltaPx) > 2) failures.push(\`${'${prefix}'} moved scroll by more than 2px\`);`,
  `    if (sample.instanceStable !== true) failures.push(\`${'${prefix}'} remounted the editor\`);\n    if (!sample.before?.selection || !sample.after?.selection) failures.push(\`${'${prefix}'}.selection evidence is missing\`);\n    else if (sample.selectionStable !== true) failures.push(\`${'${prefix}'} changed the selection\`);\n    if (typeof sample.scrollDeltaPx !== "number" || !Number.isFinite(sample.scrollDeltaPx)) {\n      failures.push(\`${'${prefix}'}.scrollDeltaPx is missing\`);\n    } else if (Math.abs(sample.scrollDeltaPx) > 2) {\n      failures.push(\`${'${prefix}'} moved scroll by more than 2px\`);\n    }`,
) || changed;

changed = replaceOnce(
  "scripts/tests/issue-210-signoff-validator.test.mjs",
  `test("rejects missing cache and Range evidence", () => {`,
  `test("rejects missing selection and scroll evidence", () => {\n  const value = snapshot("web");\n  value.saveSamples[0].before.selection = null;\n  value.saveSamples[1].scrollDeltaPx = null;\n  const failures = validateIssue210Snapshot(value).join("\\n");\n  assert.match(failures, /selection evidence is missing/);\n  assert.match(failures, /scrollDeltaPx is missing/);\n});\n\ntest("rejects missing cache and Range evidence", () => {`,
) || changed;

console.info(changed ? "Issue #210 sign-off hardening applied" : "Issue #210 sign-off hardening already applied");
