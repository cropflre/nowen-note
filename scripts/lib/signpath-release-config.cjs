const REQUIRED_SIGNPATH_CONFIG = [
  "SIGNPATH_API_TOKEN",
  "SIGNPATH_ORGANIZATION_ID",
  "SIGNPATH_PROJECT_SLUG",
  "SIGNPATH_SIGNING_POLICY_SLUG",
  "SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG",
  "SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG",
  "NOWEN_WINDOWS_PUBLISHER_NAME",
];

function missingSignPathConfig(env = process.env) {
  return REQUIRED_SIGNPATH_CONFIG.filter((name) => !String(env?.[name] ?? "").trim());
}

function validateSignPathReleaseConfig(env = process.env) {
  const missing = missingSignPathConfig(env);
  return {
    ok: missing.length === 0,
    missing,
    configured: REQUIRED_SIGNPATH_CONFIG.filter((name) => !missing.includes(name)),
  };
}

module.exports = {
  REQUIRED_SIGNPATH_CONFIG,
  missingSignPathConfig,
  validateSignPathReleaseConfig,
};
