const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyExtractedDesktopPackage } = require("./lib/linux-desktop-package.cjs");

// Extract only; this check never installs or launches the application.
function verifyDeb(filePath) {
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-linux-desktop-"));
  try {
    execFileSync("dpkg-deb", ["--extract", filePath, extracted], { stdio: "inherit" });
    const result = verifyExtractedDesktopPackage(extracted);
    execFileSync("desktop-file-validate", [result.desktopPath], { stdio: "inherit" });
    console.log(`Verified ${path.basename(filePath)}: ${result.iconName}, ${result.iconSizes.join(", ")}px icons`);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

try {
  const target = path.resolve(process.argv[2] || "dist-electron");
  const packages = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((name) => name.endsWith(".deb")).sort().map((name) => path.join(target, name))
    : target.endsWith(".deb") ? [target] : [];
  if (packages.length === 0) throw new Error(`No Debian packages found in ${target}`);
  for (const filePath of packages) verifyDeb(filePath);
} catch (error) {
  console.error(`Linux desktop package verification failed: ${error.message}`);
  process.exitCode = 1;
}
