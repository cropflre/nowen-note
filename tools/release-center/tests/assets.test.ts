import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Existing release scripts are JavaScript without declarations.
import { createManifest } from "../../../scripts/release-center-assets.mjs";

async function assets(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "nowen-debug-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from("unsigned fixture installer");
  const sha512 = createHash("sha512").update(binary).digest("base64");
  await writeFile(join(directory, "Nowen-Note-1.5.2-setup.exe"), binary);
  await writeFile(join(directory, "Nowen-Note-1.5.2-portable.exe"), binary);
  await writeFile(
    join(directory, "Nowen-Note-1.5.2-setup.exe.blockmap"),
    "blockmap",
  );
  await writeFile(
    join(directory, "latest.yml"),
    `version: 1.5.2\nfiles:\n  - url: Nowen-Note-1.5.2-setup.exe\n    sha512: ${sha512}\n    size: ${binary.length}\npath: Nowen-Note-1.5.2-setup.exe\nsha512: ${sha512}\n`,
  );
  return {
    directory,
    options: {
      platform: "windows",
      taskId: randomUUID(),
      sha: "a".repeat(40),
      version: "1.5.2",
    },
  };
}
test("debug manifest uses existing updater validation and records per-file size, arch and SHA-256", async (t) => {
  const f = await assets(t);
  const result = await createManifest(f.directory, f.options);
  assert.equal(result.purpose, "debug-only");
  assert.equal(result.signed, false);
  assert.deepEqual(result.updaterVerification, ["latest.yml"]);
  const installer = result.files.find((a: any) => a.name.endsWith("setup.exe"));
  assert.equal(installer.architecture, "x64");
  assert.equal(
    installer.sha256,
    createHash("sha256")
      .update(await readFile(join(f.directory, installer.name)))
      .digest("hex"),
  );
});
test("missing installer, corrupted SHA, and Store packages block artifact staging", async (t) => {
  const f = await assets(t);
  await rm(join(f.directory, "Nowen-Note-1.5.2-setup.exe"));
  await assert.rejects(createManifest(f.directory, f.options), /Missing/);
  await writeFile(join(f.directory, "Nowen-Note-1.5.2-setup.exe"), "corrupted");
  await assert.rejects(
    createManifest(f.directory, f.options),
    /sha512 mismatch/,
  );
  await writeFile(join(f.directory, "accidental.appx"), "store");
  await assert.rejects(createManifest(f.directory, f.options), /Store/);
});

test("builder diagnostics are excluded and stale-version binaries cannot enter the manifest", async (t) => {
  const f = await assets(t);
  await writeFile(join(f.directory, "builder-debug.yml"), "diagnostics");
  const manifest = await createManifest(f.directory, f.options);
  assert.ok(
    !manifest.files.some((file: any) => file.name === "builder-debug.yml"),
  );
  await writeFile(join(f.directory, "Nowen-Note-1.4.0-setup.exe"), "stale");
  await assert.rejects(
    createManifest(f.directory, f.options),
    /Unexpected debug artifact/,
  );
});
