import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTENSION_CAPABILITY_CATALOG,
  EXTENSION_CAPABILITY_CATALOG_DIGEST,
} from "../src/plugins/capabilityCatalog.generated";
import { HOST_API_CONTRACT_VERSION } from "../src/plugins/hostApiContract";

test("unified capability catalog keeps host, contribution and AI boundaries in sync", () => {
  assert.equal(HOST_API_CONTRACT_VERSION, 2);
  assert.equal(EXTENSION_CAPABILITY_CATALOG.hostApi.contractVersion, 2);
  assert.equal(EXTENSION_CAPABILITY_CATALOG.hostApi.templates.v21EngineRange, ">=1.6.0");
  assert.match(EXTENSION_CAPABILITY_CATALOG_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(EXTENSION_CAPABILITY_CATALOG.digest, EXTENSION_CAPABILITY_CATALOG_DIGEST);

  const permissions = new Set(EXTENSION_CAPABILITY_CATALOG.hostApi.permissions.map((item) => item.id));
  assert.equal(permissions.has("attachments:write"), false);
  const contributions = new Set(EXTENSION_CAPABILITY_CATALOG.contributions.types.map((item) => item.id));
  for (const id of ["appearances", "noteTemplates", "promptPacks"]) assert.equal(contributions.has(id), true);
  const errors = new Set(EXTENSION_CAPABILITY_CATALOG.errors.errors.map((item) => item.code));
  assert.equal(errors.has("EXTERNAL_FETCH_INVALID_URL"), true);
  assert.equal(errors.has("PLUGIN_V21_FEATURE_DISABLED"), true);

  const serialized = JSON.stringify(EXTENSION_CAPABILITY_CATALOG);
  for (const forbidden of ["ELECTRON_USER_DATA", "BEGIN PRIVATE KEY", "installedPath", "registryPrivateKey", "secretValue"]) {
    assert.equal(serialized.includes(forbidden), false, `catalog leaked forbidden marker: ${forbidden}`);
  }
});
