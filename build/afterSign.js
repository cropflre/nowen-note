/**
 * electron-builder afterSign 钩子：macOS 公证（notarize）。
 *
 * 启用方式：
 * 1. 在 builder.config.js 里把 mac.afterSign 改为 "build/afterSign.js"
 * 2. 安装 @electron/notarize（或 electron-notarize）为 devDependency
 *    npm i -D @electron/notarize
 * 3. 设置以下环境变量中的一组：
 *    方案 A（推荐，基于 App Store Connect API Key）：
 *      APPLE_API_KEY       = /path/to/AuthKey_XXXX.p8
 *      APPLE_API_KEY_ID    = XXXXXXXXXX
 *      APPLE_API_ISSUER    = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *    方案 B（基于 Apple ID）：
 *      APPLE_ID                      = your-apple-id@example.com
 *      APPLE_APP_SPECIFIC_PASSWORD   = xxxx-xxxx-xxxx-xxxx
 *      APPLE_TEAM_ID                 = XXXXXXXXXX
 *
 * 未设置任何变量时自动跳过（本地构建友好）。
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const useApiKey =
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER;
  const useAppleId =
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID;

  if (!useApiKey && !useAppleId) {
    console.log("[afterSign] 未检测到公证凭据，跳过 notarize。");
    return;
  }

  let notarize;
  try {
    ({ notarize } = require("@electron/notarize"));
  } catch (e) {
    console.warn(
      "[afterSign] @electron/notarize 未安装，跳过公证。请运行：npm i -D @electron/notarize"
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[afterSign] notarizing ${appPath} ...`);

  const common = {
    appPath,
    tool: "notarytool",
  };

  if (useApiKey) {
    await notarize({
      ...common,
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    });
  } else {
    await notarize({
      ...common,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  }

  console.log("[afterSign] notarize done.");
};
