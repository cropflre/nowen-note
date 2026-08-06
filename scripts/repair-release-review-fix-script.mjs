import fs from "node:fs";

const file = "scripts/apply-release-review-fixes.mjs";
const source = fs.readFileSync(file, "utf8");
const startMarker = "    if (after !== before) {\\n";
const endMarker = "const releaseBody =";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  throw new Error("Unable to locate the escaped workflow/version section");
}

const repaired = source.slice(0, start)
  + source.slice(start, end).replace(/\\n/g, "\n")
  + source.slice(end);

fs.writeFileSync(file, repaired);
console.log("Repaired staged release fix script");
