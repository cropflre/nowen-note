import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_API_CONTRACT_VERSION,
  CONTRIBUTION_CONTRACT,
  NOWEN_PLUGIN_ERROR_CATALOG,
  createHostApiCallMock,
} from "../dist/index.js";

test("generated capability contracts expose V2.1 contributions without shrinking legacy errors", async () => {
  assert.equal(HOST_API_CONTRACT_VERSION, 2);
  const contributionIds = new Set(CONTRIBUTION_CONTRACT.map((entry) => entry.id));
  for (const id of ["appearances", "noteTemplates", "promptPacks"]) assert.equal(contributionIds.has(id), true);
  const errorCodes = new Set(NOWEN_PLUGIN_ERROR_CATALOG.map((entry) => entry.code));
  assert.equal(errorCodes.has("EXTERNAL_FETCH_INVALID_URL"), true);
  assert.equal(errorCodes.has("PLUGIN_ACTION_MISMATCH"), true);
  assert.equal(errorCodes.has("PLUGIN_V21_FEATURE_DISABLED"), true);

  const mock = createHostApiCallMock({
    "runtime.capabilities": async () => ({ apiVersion: 2, runtime: "sandbox-js" }),
  });
  assert.deepEqual(await mock.call("runtime.capabilities"), { apiVersion: 2, runtime: "sandbox-js" });
  assert.deepEqual(mock.calls, [{ method: "runtime.capabilities", input: {} }]);
  mock.reset();
  assert.equal(mock.calls.length, 0);
});
