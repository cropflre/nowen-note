const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

// Validate the backend's own dependencies, never the root's different sharp version.
function verifySharpRuntime(backendDir, { platform, arch }) {
  const runtime = `${platform}-${arch}`;
  try {
    const sharpManifest = path.join(backendDir, "node_modules/sharp/package.json");
    const sharpPackage = JSON.parse(fs.readFileSync(sharpManifest, "utf8"));
    const fromSharp = createRequire(sharpManifest);
    for (const name of [`@img/sharp-${runtime}`, `@img/sharp-libvips-${runtime}`]) {
      const expected = sharpPackage.optionalDependencies?.[name];
      if (!expected) {
        if (name === `@img/sharp-${runtime}`) throw new Error(`unsupported sharp runtime: ${runtime}`);
        continue; // sharp 0.33 Windows packages include libvips in the native package.
      }
      const manifest = fromSharp.resolve(`${name}/package`);
      const installed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (installed.version !== expected) {
        throw new Error(`${name}: expected ${expected}, found ${installed.version}`);
      }
      if (name === `@img/sharp-${runtime}`) fromSharp.resolve(`${name}/sharp.node`);
      if (!fs.readdirSync(path.join(path.dirname(manifest), "lib")).length) {
        throw new Error(`${name}: missing native libraries`);
      }
    }
    if (platform === process.platform && arch === process.arch) {
      execFileSync(process.execPath, ["-e", `
        const sharp = require(${JSON.stringify(path.dirname(sharpManifest))});
        sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
          .png().toBuffer().catch(error => { console.error(error); process.exitCode = 1; });
      `], { encoding: "utf8", timeout: 15000, windowsHide: true });
    }
  } catch (error) {
    throw new Error(`[builder] sharp runtime ${runtime} is incomplete in ${backendDir}: ${error.message}\n`
      + `Install backend dependencies for the target before packaging: npm --prefix backend install --include=optional --os=${platform} --cpu=${arch}`);
  }
}

module.exports = { verifySharpRuntime };
