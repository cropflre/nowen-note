const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
require("app-builder-lib");
const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper");
const { PlatformPackager } = require("app-builder-lib/out/platformPackager");
const { iconSizes, verifyExtractedDesktopPackage } = require("../lib/linux-desktop-package.cjs");

const root = path.resolve(__dirname, "../..");
const variants = [
  {
    config: require(path.join(root, "electron/builder.config.js")),
    keywords: "note;markdown;editor;nowen;",
    startupWMClass: "Nowen Note",
  },
  {
    config: require(path.join(root, "electron/builder.lite.config.js")),
    keywords: "note;markdown;editor;nowen;lite;",
    startupWMClass: "Nowen Note Lite",
  },
];

function desktopHelper(startupWMClass) {
  return new LinuxTargetHelper({
    appInfo: {
      productName: startupWMClass,
      sanitizedProductName: startupWMClass.replaceAll(" ", "-"),
      description: "Nowen Note",
    },
    config: {},
    executableName: "nowen-note",
    fileAssociations: [],
    platformSpecificBuildOptions: {},
  });
}

function readPngSize(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 24);
  assert.deepEqual(
    [...header.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${filePath} must be a PNG file`,
  );
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
}

test("Linux desktop metadata matches electron-builder 25's flat format", async () => {
  for (const { config, keywords, startupWMClass } of variants) {
    assert.equal(config.linux.icon, "build/icons");
    assert.deepEqual(config.linux.desktop, {
      StartupWMClass: startupWMClass,
      Keywords: keywords,
    });

    const helper = desktopHelper(startupWMClass);
    const desktopEntry = await helper.computeDesktopEntry(config.linux);
    assert.match(desktopEntry, new RegExp(`^StartupWMClass=${startupWMClass}$`, "m"));
    assert.match(desktopEntry, new RegExp(`^Keywords=${keywords}$`, "m"));
    assert.doesNotMatch(desktopEntry, /^entry=/m);
  }
});

test("electron-builder resolves all standard Linux icons for Full and Lite", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-linux-icon-resolve-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  for (const { config } of variants) {
    const helper = new LinuxTargetHelper({
      platformSpecificBuildOptions: config.linux,
      config: { ...config, directories: { ...config.directories, output } },
      buildResourcesDir: path.join(root, "build"),
      projectDir: root,
      getDefaultFrameworkIcon: () => [],
      expandMacro: (value) => value,
      resolveIcon: PlatformPackager.prototype.resolveIcon,
    });
    const icons = await helper.icons;
    assert.deepEqual(icons.map((icon) => icon.size).sort((a, b) => a - b), iconSizes);
    for (const icon of icons) {
      assert.deepEqual(readPngSize(icon.file), { width: icon.size, height: icon.size });
    }
  }
});

async function extractedPackage(t, variant = variants[0]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-linux-package-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const desktopPath = path.join(directory, "usr/share/applications/nowen-note.desktop");
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  const content = await desktopHelper(variant.startupWMClass).computeDesktopEntry(variant.config.linux);
  fs.writeFileSync(desktopPath, content);
  for (const size of iconSizes) {
    const target = path.join(directory, "usr/share/icons/hicolor", `${size}x${size}`, "apps/nowen-note.png");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, "build/icons", `${size}x${size}.png`), target);
  }
  return { directory, desktopPath };
}

test("package validator accepts Full and Lite desktop entries with installed theme icons", async (t) => {
  for (const variant of variants) {
    const { directory } = await extractedPackage(t, variant);
    assert.equal(verifyExtractedDesktopPackage(directory).iconName, "nowen-note");
  }
});

test("package validator rejects the reported serialized desktop entry", async (t) => {
  const { directory, desktopPath } = await extractedPackage(t);
  fs.appendFileSync(desktopPath, "entry=[object Object]\n");
  assert.throws(() => verifyExtractedDesktopPackage(directory), /serialized object/);
});

test("package validator rejects the reported 1024px-only icon installation", async (t) => {
  const { directory } = await extractedPackage(t);
  const icons = path.join(directory, "usr/share/icons/hicolor");
  fs.rmSync(icons, { recursive: true });
  fs.mkdirSync(path.join(icons, "1024x1024/apps"), { recursive: true });
  fs.copyFileSync(path.join(root, "electron/icon.png"), path.join(icons, "1024x1024/apps/nowen-note.png"));
  assert.throws(() => verifyExtractedDesktopPackage(directory), /16x16/);
});

test("package validator rejects icons installed under a different theme name", async (t) => {
  const { directory, desktopPath } = await extractedPackage(t);
  fs.writeFileSync(desktopPath, fs.readFileSync(desktopPath, "utf8").replace("Icon=nowen-note", "Icon=missing-note"));
  assert.throws(() => verifyExtractedDesktopPackage(directory), /Icon must match/);
});

test("package validator rejects incorrect PNG dimensions", async (t) => {
  const { directory } = await extractedPackage(t);
  fs.copyFileSync(path.join(root, "build/icons/32x32.png"), path.join(directory, "usr/share/icons/hicolor/16x16/apps/nowen-note.png"));
  assert.throws(() => verifyExtractedDesktopPackage(directory), /Expected a 16x16 PNG/);
});

test("package validator rejects missing required desktop metadata", async (t) => {
  const { directory, desktopPath } = await extractedPackage(t);
  fs.writeFileSync(desktopPath, fs.readFileSync(desktopPath, "utf8").replace(/^StartupWMClass=.*\n/m, ""));
  assert.throws(() => verifyExtractedDesktopPackage(directory), /missing StartupWMClass/);
});

test("package CLI fails when no Debian artifact is present", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-linux-empty-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["scripts/verify-linux-desktop-package.cjs", directory], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Debian packages found/);
});

test("icon build creates the standard Linux icon sizes", () => {
  const result = spawnSync(process.execPath, ["scripts/build-icon.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const size of iconSizes) {
    const iconPath = path.join(root, "build/icons", `${size}x${size}.png`);
    assert.deepEqual(readPngSize(iconPath), { width: size, height: size });
  }
});
