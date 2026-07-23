import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("third-party image hosting upload is retired without deleting legacy metadata", () => {
  const route = fs.readFileSync(
    path.resolve(process.cwd(), "src/routes/image-hosting.ts"),
    "utf8",
  );

  assert.match(route, /IMAGE_HOSTING_RETIRED/);
  assert.match(route, /app\.post\("\/upload"/);
  assert.match(route, /enabled:\s*false/);
  assert.match(route, /publicBaseUrl/);
  assert.match(route, /不会访问或删除第三方 Bucket/);
  assert.match(route, /systemSettingsRepository\.deleteMany/);
  assert.doesNotMatch(route, /getDb/);
  assert.doesNotMatch(route, /uploadImageToHosting/);
  assert.doesNotMatch(route, /secretAccessKeyEnc\s*:/);
});

test("retired image-hosting services and temporary workflow are removed", () => {
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "src/services/image-hosting.ts")), false);
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "src/services/image-hosting-policy.ts")), false);
  assert.equal(
    fs.existsSync(path.resolve(process.cwd(), "../.github/workflows/pg-image-hosting-finalize.yml")),
    false,
  );
});
