const path = require("node:path");
const { verifyLocalDirectory } = require("../scripts/lib/update-metadata-validator.cjs");

const outputDir = path.resolve(process.argv[2] || "dist-electron");
const version = String(require("../package.json").version || "");

const report = verifyLocalDirectory({
  directory: outputDir,
  expectedVersion: version,
  requireMetadata: true,
});

console.log(
  `[update-metadata] verified ${report.metadataFiles.join(", ")} -> ${report.assets.map((item) => item.name).join(", ")}`,
);
