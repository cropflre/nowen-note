const path = require("node:path");
const {
  discoverMetadataFiles,
  isUpdateMetadataName,
  validateLocalMetadataFiles,
} = require("../scripts/lib/update-metadata-validator.cjs");

/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * The build fails before release collection when updater metadata points at a
 * missing/renamed asset, has a stale version, or no longer matches size/SHA-512.
 */
module.exports = async function verifyUpdateArtifacts(context) {
  const artifactPaths = Array.isArray(context?.artifactPaths) ? context.artifactPaths : [];
  const version = String(context?.packager?.appInfo?.version || require("../package.json").version || "");
  const outDir = path.resolve(
    context?.outDir ||
      (artifactPaths[0] ? path.dirname(artifactPaths[0]) : path.join(__dirname, "..", "dist-electron")),
  );

  const metadataPaths = Array.from(new Set([
    ...artifactPaths.filter((filePath) => isUpdateMetadataName(path.basename(filePath))),
    ...discoverMetadataFiles(outDir, version),
  ]));

  const hasUpdaterBinary = artifactPaths.some((filePath) => {
    const name = path.basename(filePath);
    return !/portable/i.test(name) && /\.(?:exe|zip|appimage)$/i.test(name);
  });

  const report = validateLocalMetadataFiles({
    metadataPaths,
    assetDir: outDir,
    expectedVersion: version,
    requireMetadata: hasUpdaterBinary,
  });

  const referencedNames = new Set(report.assets.map((item) => item.name));
  const unreferencedUpdaterBinaries = artifactPaths
    .map((filePath) => path.basename(filePath))
    .filter((name) => !/portable/i.test(name) && /\.(?:exe|zip|appimage)$/i.test(name))
    .filter((name) => !referencedNames.has(name));
  if (unreferencedUpdaterBinaries.length > 0) {
    throw new Error(`Updater binaries are not referenced by generated metadata: ${unreferencedUpdaterBinaries.join(", ")}`);
  }

  if (report.metadataFiles.length > 0) {
    console.log(
      `[update-metadata] verified ${report.metadataFiles.join(", ")} -> ${report.assets.map((item) => item.name).join(", ")}`,
    );
  }

  // electron-builder treats returned paths as extra release artifacts. Validation
  // does not add files, so return an empty list.
  return [];
};
