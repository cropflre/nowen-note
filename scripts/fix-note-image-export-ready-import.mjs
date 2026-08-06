import fs from "node:fs";

const exportCenterFile = "frontend/src/components/NoteImageExportCenter.tsx";
let exportCenterSource = fs.readFileSync(exportCenterFile, "utf8");
const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*"@\/lib\/noteImageExportBridge";/;
const match = exportCenterSource.match(importPattern);

if (!match) {
  throw new Error("noteImageExportBridge import block not found");
}

if (!match[1].includes("setNoteImageExportCenterReady")) {
  const names = match[1].trimEnd();
  exportCenterSource = exportCenterSource.replace(
    importPattern,
    `import {${names},\n  setNoteImageExportCenterReady,\n} from "@/lib/noteImageExportBridge";`,
  );
}

fs.writeFileSync(exportCenterFile, exportCenterSource);

const releaseTestFile = "scripts/tests/release-version-consistency.test.mjs";
fs.writeFileSync(releaseTestFile, `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("release version sources stay consistent", () => {
  const root = json("package.json");
  const rootLock = json("package-lock.json");
  const backend = json("backend/package.json");
  const backendLock = json("backend/package-lock.json");
  const frontend = json("frontend/package.json");
  const changelog = json("frontend/public/changelog.json");
  const android = fs.readFileSync("frontend/android/app/build.gradle", "utf8");
  const markdown = fs.readFileSync("CHANGELOG.md", "utf8");

  assert.match(root.version, /^\\d+\\.\\d+\\.\\d+$/);
  assert.equal(rootLock.version, root.version);
  assert.equal(rootLock.packages[""].version, root.version);
  assert.equal(backend.version, root.version);
  assert.equal(backendLock.version, root.version);
  assert.equal(backendLock.packages[""].version, root.version);
  assert.equal(changelog.entries[0].version, root.version);
  assert.match(
    markdown,
    new RegExp(\`## v\${root.version.replace(/\\./g, "\\\\.")} - \\d{4}-\\d{2}-\\d{2}\`),
  );

  const [major, minor, patch] = root.version.split(".").map(Number);
  const expectedCode = major * 10_000 + minor * 100 + patch;
  assert.ok(android.includes(\`versionName "\${root.version}"\`));
  assert.ok(android.includes(\`versionCode \${expectedCode}\`));
  assert.equal(frontend.engines?.node, ">=22.0.0");
});
`);

console.log("Completed release-review post-patch fixes");
