const fs = require("fs");
const path = require("path");

const FORBIDDEN_SYNC_NOTIFICATION_TEXT = [
  "同步暂时失败",
  "本地内容未丢失，可以重新同步",
  "项修改尚未同步",
  "本地内容已保留，可查看后重新同步",
];

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css"]);

function collectTextAssets(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTextAssets(entryPath);
    return TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function verifySyncNotificationUi(
  distDirectory = path.resolve(__dirname, "..", "frontend", "dist"),
) {
  const indexFile = path.join(distDirectory, "index.html");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`[sync-ui] 前端构建产物不存在：${indexFile}`);
  }

  for (const assetFile of collectTextAssets(distDirectory)) {
    const content = fs.readFileSync(assetFile, "utf8");
    const forbiddenText = FORBIDDEN_SYNC_NOTIFICATION_TEXT.find((text) =>
      content.includes(text),
    );
    if (!forbiddenText) continue;

    throw new Error(
      `[sync-ui] 检测到旧版全局同步失败提示“${forbiddenText}”：` +
        `${path.relative(distDirectory, assetFile)}。请重新构建前端，禁止打包遗留 dist。`,
    );
  }
}

if (require.main === module) {
  verifySyncNotificationUi();
}

module.exports = { verifySyncNotificationUi };
