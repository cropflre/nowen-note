import type { i18n as I18nInstance } from "i18next";

/**
 * release/v1.4.6 compatibility bridge.
 *
 * A few large legacy settings panels still contain user-facing Chinese literals.
 * Rewriting those multi-thousand-line files in the release branch would create an
 * unnecessarily large and risky diff, so this bridge translates only exact known
 * legacy strings inside SettingsModal (plus dialogs opened on top of it).
 *
 * It never walks the editor/note workspace. New or actively maintained components
 * should use react-i18next directly; this bridge is intentionally narrow and can be
 * deleted after the remaining legacy settings panels are migrated to t().
 */

const SETTINGS_ROOT_SELECTOR = '[data-swipe-blocker="settings-modal"]';

const STATIC_COPY: ReadonlyArray<readonly [string, string]> = [
  // Settings / About / updater
  ["版本信息", "Version information"],
  ["重新拉取", "Reload version information"],
  ["检查中", "Checking"],
  ["重新检查", "Check again"],
  ["当前客户端", "Current client"],
  ["服务端", "Server"],
  ["需刷新", "Refresh needed"],
  ["匹配", "Matched"],
  ["最新发布", "Latest release"],
  ["不可用", "Unavailable"],
  ["可升级", "Update available"],
  ["发布渠道", "Release channel"],
  ["前往下载页", "Open download page"],
  ["免安装版不支持自动更新，请下载新版本 portable.exe 替换当前文件。", "The portable build does not support automatic updates. Download the new portable.exe and replace the current file."],
  ["检查桌面端更新", "Check for desktop updates"],
  ["正在检查更新…", "Checking for updates…"],
  ["已是最新版本", "You're up to date"],
  ["点击放大", "Zoom image"],
  ["关闭 (Esc)", "Close (Esc)"],
  ["隐藏桌面端菜单栏", "Hide desktop menu bar"],
  ["仅 Windows/Linux 生效；隐藏后可按 Alt 临时显示菜单栏，快捷键仍然可用。", "Windows/Linux only. Press Alt to temporarily show the menu bar; shortcuts remain available."],
  ["关闭网页端页面", "Disable Web UI"],
  ["开启后服务器只保留 API；浏览器访问网页端会显示禁用提示。桌面客户端使用本地界面连接 API，不受影响。", "When enabled, the server exposes only the API and browser visits show a disabled notice. Desktop clients use their local UI and are unaffected."],
  ["快捷键", "Shortcuts"],
  ["离线同步", "Offline Sync"],

  // Data manager — task transfer + sync card
  ["任务数据", "Task data"],
  ["导入或导出当前空间的待办、项目、层级、提醒和任务图片。", "Import or export tasks, projects, hierarchy, reminders, and task images in the current space."],
  ["管理导入与导出", "Manage import and export"],
  ["尚未同步", "Never synced"],
  ["同步完成", "Sync complete"],
  ["本地优先同步", "Local-first sync"],
  ["立即同步", "Sync now"],

  // Desktop data safety card
  ["打开数据目录失败", "Failed to open the data directory"],
  ["本地数据位置", "Local data location"],
  ["轻量模式数据存储在远端服务器，本机不保存完整数据库。", "Lite mode stores full data on the remote server, not on this device."],
  ["轻量模式连接远端服务器，本机不保存完整数据库。", "Lite mode connects to a remote server and does not store the full database on this device."],
  ["自定义目录", "Custom directory"],
  ["打开数据目录", "Open data directory"],
  ["更改位置", "Change location"],
  ["恢复本地自动登录", "Restore local auto sign-in"],
  ["请选择有效的绝对路径", "Choose a valid absolute path"],
  ["新目录不能与当前目录相同", "The new directory cannot be the current directory"],
  ["新目录不能放在当前数据目录内部", "The new directory cannot be inside the current data directory"],
  ["不能选择磁盘根目录", "The disk root cannot be used"],
  ["不能选择应用安装目录", "The application installation directory cannot be used"],
  ["目标路径不是文件夹", "The target path is not a directory"],
  ["目标目录非空，请选择空目录或已有 nowen-note 数据目录", "The target directory is not empty. Choose an empty directory or an existing nowen-note data directory."],
  ["轻量模式不使用本机完整数据库", "Lite mode does not use a full local database"],
  ["创建目标目录失败", "Failed to create the target directory"],
  ["迁移本地数据目录？", "Move the local data directory?"],
  ["迁移并重启", "Move and restart"],
  ["正在迁移本地数据，请不要关闭应用…", "Moving local data. Do not close the app…"],
  ["迁移完成，应用即将重启。", "Migration complete. The app will restart shortly."],
  ["本地自动登录已恢复，正在刷新。", "Local auto sign-in has been restored. Refreshing…"],

  // ZIP metadata hints
  ["✓ 已根据备份元数据自动选中原笔记本：", "✓ Original notebook selected from backup metadata:"],
  ["ⓘ 备份来自其他实例或工作区", "ⓘ This backup comes from another instance or workspace"],
  ["；当前空间未找到同 id 的笔记本，可手动选择目标或保持「自动创建」。", "; no notebook with the same ID exists in this space. Choose a destination manually or keep “Auto-create”."],

  // Attachment/object-storage admin section
  ["管理员验证", "Admin verification"],
  ["保存或测试对象存储配置需要输入当前管理员密码。", "Enter the current administrator password to save or test object storage settings."],
  ["继续", "Continue"],
  ["当前密码", "Current password"],
  ["配置已保存，连接测试通过。", "Settings saved and connection test passed."],
  ["连接测试失败", "Connection test failed"],
  ["配置已保存。", "Settings saved."],
  ["恢复附件存储默认来源", "Restore default attachment storage source"],
  ["这会删除保存在数据库里的对象存储配置。之后系统会重新使用环境变量配置；如果没有环境变量，则回到本地附件存储。", "This removes the object storage settings saved in the database. The system will then use environment variables again, or local attachment storage if none are configured."],
  ["恢复默认来源", "Restore default source"],
  ["已恢复默认来源。当前会使用环境变量配置；未配置环境变量时使用本地存储。", "Default source restored. Environment-variable settings are now used; local storage is used when no environment variables are configured."],
  ["恢复默认来源失败", "Failed to restore the default source"],
  ["远端检查失败", "Remote check failed"],
  ["附件存储", "Attachment storage"],
  ["刷新", "Refresh"],
  ["当前模式", "Current mode"],
  ["对象存储", "Object storage"],
  ["本地存储", "Local storage"],
  ["数据库附件", "Database attachments"],
  ["本地文件", "Local files"],
  ["本地目录", "Local directory"],
  ["对象存储配置", "Object storage settings"],
  ["来源：", "Source:"],
  ["系统设置", "System settings"],
  ["环境变量", "Environment variables"],
  ["默认本地", "Default local"],
  ["启用", "Enable"],
  ["Secret 已保存，留空不修改", "Secret is saved; leave blank to keep it unchanged"],
  ["保存配置", "Save settings"],
  ["保存并测试", "Save and test"],
  ["迁移检查", "Migration check"],
  ["远端对象检查", "Remote object check"],
  ["默认抽样检查 50 个数据库附件路径", "Checks a sample of 50 database attachment paths by default"],
  ["检查远端", "Check remote"],
  ["正在读取附件存储状态...", "Loading attachment storage status..."],
];

function replaceStatic(text: string, english: boolean): string {
  for (const [zh, en] of STATIC_COPY) {
    if (english && text === zh) return en;
    if (!english && text === en) return zh;
  }
  return text;
}

function replaceDynamic(text: string, english: boolean): string {
  let match: RegExpMatchArray | null;

  if (english) {
    if ((match = text.match(/^发现新版本 v(.+)，准备下载$/))) return `Version v${match[1]} is available and will be downloaded`;
    if ((match = text.match(/^正在下载(.*)$/))) return `Downloading${match[1]}`;
    if ((match = text.match(/^新版本 v(.+) 已下载，将在下次重启时安装$/))) return `Version v${match[1]} has been downloaded and will install on the next restart`;
    if ((match = text.match(/^更新失败：(.*)$/))) return `Update failed: ${match[1]}`;
    if ((match = text.match(/^待同步 (\d+) 条$/))) return `${match[1]} pending`;
    if (text === "上次同步 尚未同步") return "Never synced";
    if ((match = text.match(/^上次同步 (.+)$/))) return `Last synced ${match[1]}`;
    if ((match = text.match(/^最近错误：(.*)$/))) return `Recent error: ${match[1]}`;
    if ((match = text.match(/^同步失败：(.*)$/))) return `Sync failed: ${match[1]}`;
    if ((match = text.match(/^数据库文件：nowen-note\.db · 日志目录：(.*)$/))) return `Database: nowen-note.db · Logs: ${match[1]}`;
    if ((match = text.match(/^选择目录失败：(.*)$/))) return `Failed to choose directory: ${replaceStatic(match[1], true)}`;
    if ((match = text.match(/^恢复失败：(.*)$/))) return `Restore failed: ${match[1]}`;
    if ((match = text.match(/^迁移失败：(.*)$/))) return `Migration failed: ${replaceStatic(match[1], true)}`;
    if ((match = text.match(/^；后端恢复失败：(.*)$/))) return `; backend recovery failed: ${match[1]}`;
    if ((match = text.match(/^将把数据库、附件、备份和设置迁移到：\n([\s\S]+?)\n\n迁移会先停止本地后端并在完成后重启应用。迁移成功前请不要关闭应用。旧目录不会自动删除。$/))) {
      return `Database, attachments, backups, and settings will be moved to:\n${match[1]}\n\nThe local backend will stop during migration and the app will restart when finished. Do not close the app until migration succeeds. The old directory will not be deleted automatically.`;
    }
    if ((match = text.match(/^已检查 (\d+)\/(\d+) 个，存在 (\d+) 个，缺失 (\d+) 个，错误 (\d+) 个$/))) {
      return `Checked ${match[1]}/${match[2]}: ${match[3]} found, ${match[4]} missing, ${match[5]} errors`;
    }
    if ((match = text.match(/^缺失: (.+)$/))) return `Missing: ${match[1]}`;
    if ((match = text.match(/^错误: (.+)$/))) return `Error: ${match[1]}`;
    if ((match = text.match(/^(\d+) 个 · (.+)$/))) return `${match[1]} · ${match[2]}`;
    if ((match = text.match(/^（原笔记本：(.+)）$/))) return `(Original notebook: ${match[1]})`;
  } else {
    if ((match = text.match(/^Version v(.+) is available and will be downloaded$/))) return `发现新版本 v${match[1]}，准备下载`;
    if ((match = text.match(/^Downloading(.*)$/))) return `正在下载${match[1]}`;
    if ((match = text.match(/^Version v(.+) has been downloaded and will install on the next restart$/))) return `新版本 v${match[1]} 已下载，将在下次重启时安装`;
    if ((match = text.match(/^Update failed: (.*)$/))) return `更新失败：${match[1]}`;
    if ((match = text.match(/^(\d+) pending$/))) return `待同步 ${match[1]} 条`;
    if ((match = text.match(/^Last synced (.+)$/))) return `上次同步 ${match[1]}`;
    if ((match = text.match(/^Recent error: (.*)$/))) return `最近错误：${match[1]}`;
    if ((match = text.match(/^Sync failed: (.*)$/))) return `同步失败：${match[1]}`;
    if ((match = text.match(/^Database: nowen-note\.db · Logs: (.*)$/))) return `数据库文件：nowen-note.db · 日志目录：${match[1]}`;
    if ((match = text.match(/^Failed to choose directory: (.*)$/))) return `选择目录失败：${replaceStatic(match[1], false)}`;
    if ((match = text.match(/^Restore failed: (.*)$/))) return `恢复失败：${match[1]}`;
    if ((match = text.match(/^Migration failed: (.*)$/))) return `迁移失败：${replaceStatic(match[1], false)}`;
    if ((match = text.match(/^; backend recovery failed: (.*)$/))) return `；后端恢复失败：${match[1]}`;
    if ((match = text.match(/^Checked (\d+)\/(\d+): (\d+) found, (\d+) missing, (\d+) errors$/))) {
      return `已检查 ${match[1]}/${match[2]} 个，存在 ${match[3]} 个，缺失 ${match[4]} 个，错误 ${match[5]} 个`;
    }
    if ((match = text.match(/^Missing: (.+)$/))) return `缺失: ${match[1]}`;
    if ((match = text.match(/^Error: (.+)$/))) return `错误: ${match[1]}`;
    if ((match = text.match(/^\(Original notebook: (.+)\)$/))) return `（原笔记本：${match[1]}）`;
  }

  return text;
}

function translateText(text: string, english: boolean): string {
  const staticResult = replaceStatic(text, english);
  return staticResult === text ? replaceDynamic(text, english) : staticResult;
}

function translateNodeText(node: Text, english: boolean) {
  const raw = node.nodeValue ?? "";
  const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !match[2]) return;
  const translated = translateText(match[2], english);
  if (translated !== match[2]) node.nodeValue = `${match[1]}${translated}${match[3]}`;
}

function translateElementAttributes(element: Element, english: boolean) {
  for (const name of ["title", "aria-label", "placeholder"] as const) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const translated = translateText(value, english);
    if (translated !== value) element.setAttribute(name, translated);
  }
}

function translateLeafElementText(element: Element, english: boolean) {
  if (element.childElementCount !== 0) return;
  const raw = element.textContent ?? "";
  if (!raw.trim()) return;
  const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !match[2]) return;
  const translated = translateText(match[2], english);
  if (translated !== match[2]) element.textContent = `${match[1]}${translated}${match[3]}`;
}

function translateRoot(root: Element, english: boolean) {
  translateElementAttributes(root, english);
  translateLeafElementText(root, english);
  root.querySelectorAll("*").forEach((element) => {
    translateElementAttributes(element, english);
    translateLeafElementText(element, english);
  });

  // Mixed-content controls (for example an icon plus label) are not leaf elements,
  // so translate their remaining standalone text nodes without flattening markup.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateNodeText(node as Text, english);
    node = walker.nextNode();
  }
}

function findSettingsRoot(node: Node): Element | null {
  if (!(node instanceof Element)) return null;
  if (node.matches(SETTINGS_ROOT_SELECTOR)) return node;
  return node.querySelector(SETTINGS_ROOT_SELECTOR);
}

function containsPortalDialog(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches('[role="dialog"]') || !!node.querySelector('[role="dialog"]');
}

let installed = false;

export function installLegacySettingsI18nBridge(i18n: I18nInstance) {
  if (installed || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  installed = true;

  let scheduled = false;
  let settingsRoot: Element | null = null;
  let settingsObserver: MutationObserver | null = null;

  const isEnglish = () =>
    (i18n.resolvedLanguage || i18n.language || "").toLowerCase().startsWith("en");

  const apply = () => {
    scheduled = false;
    if (!settingsRoot || !document.contains(settingsRoot)) return;
    const english = isEnglish();
    translateRoot(settingsRoot, english);

    // Confirm/prompt components opened from SettingsModal are portaled to body.
    document.querySelectorAll('[role="dialog"]').forEach((dialog) => {
      if (dialog !== settingsRoot && !settingsRoot!.contains(dialog)) translateRoot(dialog, english);
    });
  };

  const scheduleApply = () => {
    if (scheduled) return;
    scheduled = true;
    // Promise microtasks work on the project's Chrome 64 compatibility baseline.
    Promise.resolve().then(() => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
      else apply();
    });
  };

  const detachSettingsObserver = () => {
    settingsObserver?.disconnect();
    settingsObserver = null;
    settingsRoot = null;
  };

  const attachSettingsRoot = (root: Element) => {
    if (settingsRoot === root) return;
    detachSettingsObserver();
    settingsRoot = root;
    settingsObserver = new MutationObserver(scheduleApply);
    settingsObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"],
    });
    scheduleApply();
  };

  const startObserver = () => {
    if (!document.body) return;

    const existingRoot = document.querySelector(SETTINGS_ROOT_SELECTOR);
    if (existingRoot) attachSettingsRoot(existingRoot);

    // Body observer only watches structural changes. Text/attribute changes are
    // observed on the settings subtree itself, so editor typing does not schedule
    // compatibility work while SettingsModal is closed.
    const bodyObserver = new MutationObserver((mutations) => {
      if (settingsRoot && !document.contains(settingsRoot)) detachSettingsObserver();

      let shouldApplyForPortal = false;
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!settingsRoot) {
            const root = findSettingsRoot(node);
            if (root) attachSettingsRoot(root);
          }
          if (settingsRoot && containsPortalDialog(node)) shouldApplyForPortal = true;
        }
      }

      if (settingsRoot && shouldApplyForPortal) scheduleApply();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    i18n.on("languageChanged", scheduleApply);
    scheduleApply();
  };

  if (document.body) startObserver();
  else window.addEventListener("DOMContentLoaded", startObserver, { once: true });
}
