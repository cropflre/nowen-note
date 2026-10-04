const fs = require("node:fs");
const path = require("node:path");

const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512];

function verifyExtractedDesktopPackage(packageRoot) {
  const applications = path.join(packageRoot, "usr/share/applications");
  const desktops = fs.readdirSync(applications).filter((name) => name.endsWith(".desktop"));
  if (desktops.length !== 1) {
    throw new Error(`Expected one application desktop file, found ${desktops.length}`);
  }
  const desktopPath = path.join(applications, desktops[0]);
  const content = fs.readFileSync(desktopPath, "utf8");
  if (/^entry=/m.test(content) || content.includes("[object Object]")) {
    throw new Error("Desktop metadata contains a serialized object (entry=[object Object])");
  }

  const fields = new Map();
  let inDesktopEntry = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
    } else if (inDesktopEntry && !line.startsWith("#")) {
      const separator = line.indexOf("=");
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  for (const key of ["Name", "Exec", "Icon", "StartupWMClass", "Keywords"]) {
    if (!fields.get(key)?.trim()) throw new Error(`Desktop metadata is missing ${key}`);
  }
  if (fields.get("Type") !== "Application") {
    throw new Error("Desktop Type must be Application");
  }
  const iconName = fields.get("Icon");
  if (!/^[A-Za-z0-9._-]+$/.test(iconName) || `${iconName}.desktop` !== desktops[0]) {
    throw new Error(`Desktop Icon must match the installed application name: ${iconName}`);
  }

  for (const size of iconSizes) {
    const iconPath = path.join(packageRoot, "usr/share/icons/hicolor", `${size}x${size}`, "apps", `${iconName}.png`);
    const header = fs.readFileSync(iconPath).subarray(0, 24);
    if (header.length !== 24 ||
        !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        header.toString("ascii", 12, 16) !== "IHDR" ||
        header.readUInt32BE(16) !== size || header.readUInt32BE(20) !== size) {
      throw new Error(`Expected a ${size}x${size} PNG: ${iconPath}`);
    }
  }
  return { desktopPath, iconName, iconSizes };
}

module.exports = { iconSizes, verifyExtractedDesktopPackage };
