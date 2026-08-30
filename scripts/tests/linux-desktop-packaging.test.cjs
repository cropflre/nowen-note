const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper");

const root = path.resolve(__dirname, "../..");
const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512];

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
  const variants = [
    {
      config: require(path.join(root, "electron/builder.base.config.js")),
      keywords: "note;markdown;editor;nowen;",
      startupWMClass: "Nowen Note",
    },
    {
      config: require(path.join(root, "electron/builder.lite.base.config.js")),
      keywords: "note;markdown;editor;nowen;lite;",
      startupWMClass: "Nowen Note Lite",
    },
  ];

  for (const { config, keywords, startupWMClass } of variants) {
    assert.equal(config.linux.icon, "build/icons");
    assert.deepEqual(config.linux.desktop, {
      StartupWMClass: startupWMClass,
      Keywords: keywords,
    });

    const helper = new LinuxTargetHelper({
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
    const desktopEntry = await helper.computeDesktopEntry(config.linux);
    assert.match(desktopEntry, new RegExp(`^StartupWMClass=${startupWMClass}$`, "m"));
    assert.match(desktopEntry, new RegExp(`^Keywords=${keywords}$`, "m"));
    assert.doesNotMatch(desktopEntry, /^entry=/m);
  }
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
