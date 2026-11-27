import type { LucideIcon } from "lucide-react";

export type SettingsTabId =
  | "appearance"
  | "preferences"
  | "shortcuts"
  | "ai"
  | "automations"
  | "security"
  | "tokens"
  | "data"
  | "sync"
  | "folderSync"
  | "users"
  | "workspaces"
  | "extensions"
  | "download"
  | "ecosystem"
  | "about";

export type SettingsNavGroupId = "craft" | "intelligence" | "dataSync" | "system";

export type NavIconMotion = "wiggle" | "bounce" | "tilt" | "spin";

export interface SettingsNavItem {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
}

export interface SettingsTabMeta {
  group: SettingsNavGroupId;
  motion: NavIconMotion;
  taglineZh: string;
  taglineEn: string;
  badgeTone: string;
  activeText: string;
  activeBar: string;
  heroGlow: string;
  keywords: string[];
}

export const SETTINGS_NAV_GROUP_ORDER: SettingsNavGroupId[] = [
  "craft",
  "intelligence",
  "dataSync",
  "system",
];

export const SETTINGS_NAV_GROUP_META: Record<
  SettingsNavGroupId,
  { labelZh: string; labelEn: string; dotClass: string }
> = {
  craft: {
    labelZh: "个性与手感",
    labelEn: "Craft & Feel",
    dotClass: "bg-indigo-400",
  },
  intelligence: {
    labelZh: "智能与效率",
    labelEn: "AI & Flow",
    dotClass: "bg-fuchsia-400",
  },
  dataSync: {
    labelZh: "数据与同步",
    labelEn: "Data & Sync",
    dotClass: "bg-emerald-400",
  },
  system: {
    labelZh: "空间与系统",
    labelEn: "Space & System",
    dotClass: "bg-amber-400",
  },
};

export const SETTINGS_TAB_META: Record<SettingsTabId, SettingsTabMeta> = {
  appearance: {
    group: "craft",
    motion: "tilt",
    taglineZh: "换套皮肤、挑款称手字体，把笔记空间装扮成你喜欢的样子",
    taglineEn: "Pick a skin, tune typography, and dress your workspace",
    badgeTone: "from-indigo-500/20 to-sky-500/20 text-indigo-600 ring-indigo-500/25 dark:text-indigo-300",
    activeText: "text-indigo-600 dark:text-indigo-300",
    activeBar: "bg-indigo-500",
    heroGlow: "from-indigo-500/12 via-sky-500/6 to-transparent",
    keywords: ["外观", "主题", "暗黑", "深色", "浅色", "皮肤", "字体", "字号", "语言", "时区", "站点", "图标", "横幅", "appearance", "theme", "dark", "light", "font", "skin", "language", "timezone", "time zone"],
  },
  preferences: {
    group: "craft",
    motion: "wiggle",
    taglineZh: "细调编辑习惯、导航模块与工作节奏，越用越顺手",
    taglineEn: "Fine-tune editor habits, modules, and daily workflow",
    badgeTone: "from-sky-500/20 to-cyan-500/20 text-sky-600 ring-sky-500/25 dark:text-sky-300",
    activeText: "text-sky-600 dark:text-sky-300",
    activeBar: "bg-sky-500",
    heroGlow: "from-sky-500/12 via-cyan-500/6 to-transparent",
    keywords: ["偏好", "编辑器", "习惯", "导航", "布局", "时区", "自动保存", "日历", "任务", "preferences", "editor", "layout", "timezone", "time zone", "utc"],
  },
  shortcuts: {
    group: "craft",
    motion: "bounce",
    taglineZh: "给高频动作装上称手快捷键，指尖起飞不碰鼠标",
    taglineEn: "Bind tactile shortcuts so your fingers stay on the keys",
    badgeTone: "from-violet-500/20 to-indigo-500/20 text-violet-600 ring-violet-500/25 dark:text-violet-300",
    activeText: "text-violet-600 dark:text-violet-300",
    activeBar: "bg-violet-500",
    heroGlow: "from-violet-500/12 via-indigo-500/6 to-transparent",
    keywords: ["快捷键", "键盘", "按键", "热键", "shortcuts", "keyboard", "hotkey", "keycap"],
  },
  ai: {
    group: "intelligence",
    motion: "bounce",
    taglineZh: "接入你的模型与向量索引，让知识库真正会思考",
    taglineEn: "Connect models and embeddings to give your vault a brain",
    badgeTone: "from-fuchsia-500/20 to-violet-500/20 text-fuchsia-600 ring-fuchsia-500/25 dark:text-fuchsia-300",
    activeText: "text-fuchsia-600 dark:text-fuchsia-300",
    activeBar: "bg-fuchsia-500",
    heroGlow: "from-fuchsia-500/12 via-violet-500/6 to-transparent",
    keywords: ["ai", "模型", "助手", "对话", "向量", "嵌入", "openai", "claude", "gemini", "记忆", "归档", "model", "embedding", "llm"],
  },
  automations: {
    group: "intelligence",
    motion: "spin",
    taglineZh: "把重复整理交给定时规则与触发器，省心又可靠",
    taglineEn: "Hand repetitive tidying over to schedules and triggers",
    badgeTone: "from-amber-500/20 to-orange-500/20 text-amber-600 ring-amber-500/25 dark:text-amber-300",
    activeText: "text-amber-600 dark:text-amber-300",
    activeBar: "bg-amber-500",
    heroGlow: "from-amber-500/12 via-orange-500/6 to-transparent",
    keywords: ["自动化", "规则", "定时", "触发", "工作流", "提醒", "automations", "workflow", "schedule", "cron"],
  },
  tokens: {
    group: "intelligence",
    motion: "wiggle",
    taglineZh: "通过 MCP 与访问令牌，让外部 AI 客户端安全连上你的笔记",
    taglineEn: "Bridge external AI tools safely with MCP and scoped tokens",
    badgeTone: "from-cyan-500/20 to-teal-500/20 text-cyan-600 ring-cyan-500/25 dark:text-cyan-300",
    activeText: "text-cyan-600 dark:text-cyan-300",
    activeBar: "bg-cyan-500",
    heroGlow: "from-cyan-500/12 via-teal-500/6 to-transparent",
    keywords: ["令牌", "token", "mcp", "api", "密钥", "连接", "cli", "claude", "cursor"],
  },
  data: {
    group: "dataSync",
    motion: "bounce",
    taglineZh: "全量备份、一键恢复与多格式导入导出，数据始终握在自己手里",
    taglineEn: "Full backups, safe restore, and imports—your data stays yours",
    badgeTone: "from-emerald-500/20 to-teal-500/20 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300",
    activeText: "text-emerald-600 dark:text-emerald-300",
    activeBar: "bg-emerald-500",
    heroGlow: "from-emerald-500/12 via-teal-500/6 to-transparent",
    keywords: ["数据", "备份", "恢复", "导入", "导出", "webdav", "obsidian", "notion", "思源", "附件", "backup", "restore", "import", "export"],
  },
  sync: {
    group: "dataSync",
    motion: "spin",
    taglineZh: "本地优先多端实时协同，离线安心写、联网自动汇合",
    taglineEn: "Local-first multi-device sync—write offline, converge online",
    badgeTone: "from-teal-500/20 to-sky-500/20 text-teal-600 ring-teal-500/25 dark:text-teal-300",
    activeText: "text-teal-600 dark:text-teal-300",
    activeBar: "bg-teal-500",
    heroGlow: "from-teal-500/12 via-sky-500/6 to-transparent",
    keywords: ["同步", "多端", "nas", "服务器", "冲突", "离线", "sync", "server", "conflict", "offline"],
  },
  folderSync: {
    group: "dataSync",
    motion: "wiggle",
    taglineZh: "把指定本地文件夹与笔记库双向联动，兼容本地工作流",
    taglineEn: "Mirror local folders with your vault seamlessly",
    badgeTone: "from-lime-500/20 to-emerald-500/20 text-lime-700 ring-lime-500/25 dark:text-lime-300",
    activeText: "text-lime-700 dark:text-lime-300",
    activeBar: "bg-lime-500",
    heroGlow: "from-lime-500/12 via-emerald-500/6 to-transparent",
    keywords: ["文件夹同步", "本地目录", "markdown", "folder", "mirror", "watch"],
  },
  security: {
    group: "system",
    motion: "tilt",
    taglineZh: "守护账号密码、双因素认证、会话设备与私密空间锁",
    taglineEn: "Guard passwords, 2FA, active sessions, and private locks",
    badgeTone: "from-rose-500/20 to-orange-500/20 text-rose-600 ring-rose-500/25 dark:text-rose-300",
    activeText: "text-rose-600 dark:text-rose-300",
    activeBar: "bg-rose-500",
    heroGlow: "from-rose-500/12 via-orange-500/6 to-transparent",
    keywords: ["安全", "密码", "两步验证", "2fa", "会话", "设备", "隐私", "锁", "账号", "security", "password", "account"],
  },
  users: {
    group: "system",
    motion: "bounce",
    taglineZh: "管理站点成员、角色权限与注册准入策略",
    taglineEn: "Manage members, roles, and registration access",
    badgeTone: "from-blue-500/20 to-indigo-500/20 text-blue-600 ring-blue-500/25 dark:text-blue-300",
    activeText: "text-blue-600 dark:text-blue-300",
    activeBar: "bg-blue-500",
    heroGlow: "from-blue-500/12 via-indigo-500/6 to-transparent",
    keywords: ["用户", "成员", "管理员", "权限", "注册", "users", "members", "admin"],
  },
  workspaces: {
    group: "system",
    motion: "tilt",
    taglineZh: "规划团队共享空间与成员协作边界",
    taglineEn: "Organize shared workspaces and team collaboration",
    badgeTone: "from-amber-500/20 to-yellow-500/20 text-amber-700 ring-amber-500/25 dark:text-amber-300",
    activeText: "text-amber-700 dark:text-amber-300",
    activeBar: "bg-amber-500",
    heroGlow: "from-amber-500/12 via-yellow-500/6 to-transparent",
    keywords: ["工作区", "团队", "空间", "协作", "workspaces", "team"],
  },
  extensions: {
    group: "system",
    motion: "wiggle",
    taglineZh: "管理扩展来源、运行时策略与隔离恢复工具",
    taglineEn: "Control extension sources, runtime policies, and recovery",
    badgeTone: "from-purple-500/20 to-pink-500/20 text-purple-600 ring-purple-500/25 dark:text-purple-300",
    activeText: "text-purple-600 dark:text-purple-300",
    activeBar: "bg-purple-500",
    heroGlow: "from-purple-500/12 via-pink-500/6 to-transparent",
    keywords: ["扩展", "插件", "运行时", "策略", "extensions", "plugins", "runtime"],
  },
  download: {
    group: "system",
    motion: "bounce",
    taglineZh: "获取桌面端与移动端安装包，支持多线路极速换源",
    taglineEn: "Grab desktop & mobile installers with fast mirrors",
    badgeTone: "from-sky-500/20 to-blue-500/20 text-sky-600 ring-sky-500/25 dark:text-sky-300",
    activeText: "text-sky-600 dark:text-sky-300",
    activeBar: "bg-sky-500",
    heroGlow: "from-sky-500/12 via-blue-500/6 to-transparent",
    keywords: ["下载", "客户端", "桌面端", "安卓", "windows", "macos", "apk", "download", "client"],
  },
  ecosystem: {
    group: "system",
    motion: "bounce",
    taglineZh: "弄文影视、弄文阅读、弄文书签与微信小程序，一起搭起私有数字生活",
    taglineEn: "Nowen Video, NowenReader, NOWEN Bookmarks & WeChat Mini Program",
    badgeTone: "from-indigo-500/20 to-emerald-500/20 text-indigo-600 ring-indigo-500/25 dark:text-indigo-300",
    activeText: "text-indigo-600 dark:text-indigo-300",
    activeBar: "bg-indigo-500",
    heroGlow: "from-indigo-500/12 via-emerald-500/6 to-transparent",
    keywords: ["弄文生态", "生态", "弄文影视", "弄文阅读", "弄文书签", "nowen", "video", "reader", "bookmark", "小程序", "微信", "miniprogram", "ecosystem"],
  },
  about: {
    group: "system",
    motion: "tilt",
    taglineZh: "版本脉搏、更新日志、社区伙伴与一点关于开源的初心",
    taglineEn: "Version pulse, changelog, community, and the story behind Nowen",
    badgeTone: "from-pink-500/20 to-rose-500/20 text-pink-600 ring-pink-500/25 dark:text-pink-300",
    activeText: "text-pink-600 dark:text-pink-300",
    activeBar: "bg-pink-500",
    heroGlow: "from-pink-500/12 via-rose-500/6 to-transparent",
    keywords: ["关于", "版本", "更新", "赞助", "打赏", "社区", "qq", "公众号", "开源", "about", "version", "update", "sponsor"],
  },
};

export function matchesSettingsSearch(item: SettingsNavItem, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (item.label.toLowerCase().includes(query)) return true;
  const meta = SETTINGS_TAB_META[item.id];
  if (meta.taglineZh.toLowerCase().includes(query) || meta.taglineEn.toLowerCase().includes(query)) {
    return true;
  }
  return meta.keywords.some((keyword) => keyword.toLowerCase().includes(query));
}
