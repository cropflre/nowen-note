/**
 * 极简 i18n —— 零依赖。
 *
 * 为什么不上 i18next：Lite 一共就两门语言、百来条文案，
 * i18next + 语言包加载器（~40KB gzip）比整个 App 还大，不划算。
 *
 * 设计要点：
 * 1. **词典是扁平的点号 key**（`nav.notes`），不做嵌套 —— 找 key、查重复都简单。
 * 2. **订阅式刷新**：语言一变就广播，组件用 `useI18n()` 自动重渲染。
 *    不引入 Context 是因为 BottomNav / TopBar 这些组件层级很浅，
 *    一个 module-level 的订阅表比 Provider 更省事、也不会多一层 re-render 边界。
 * 3. **缺 key 的行为**：回落到中文；中文也没有就原样返回 key
 *    —— 开发时一眼能看到漏了哪条，而不是显示空白。
 * 4. `{name}` 形式的占位符用 vars 替换，够用了。
 */

import { useCallback, useEffect, useState } from "react";

export type Lang = "zh-CN" | "en";

export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: "zh-CN", label: "简体中文", short: "中" },
  { id: "en", label: "English", short: "EN" },
];

const LANG_KEY = "nowen-lite.lang";

type Dict = Record<string, string>;

const zh: Dict = {
  // ---- 通用 ----
  "common.cancel": "取消",
  "common.confirm": "确定",
  "common.save": "保存",
  "common.saved": "已保存",
  "common.delete": "删除",
  "common.close": "关闭",
  "common.loading": "加载中…",
  "common.retry": "重试",
  "common.empty": "还没有内容",
  "common.clear": "清空",
  "common.all": "全部",
  "common.default": "默认",
  "common.on": "开",
  "common.off": "关",

  // ---- 底部导航 ----
  "notes.unnamedNotebook": "未命名笔记本",
  "notes.scopeCount": " · {n} 篇",
  "diary.viewImage": "查看第 {n} 张图片",
  "diary.removeMedia": "移除 {name}",
  "tasks.createFailed": "新建失败：{msg}",
  "tasks.toggleFailed": "勾选失败，已还原：{msg}",
  "search.mindmapNote": "（另有 {n} 条来自思维导图/表格，Lite 暂不展示）",
  "common.internalError": "服务端未返回新笔记的 id",
  "nav.notes": "笔记",
  "nav.diary": "日记说说",
  "nav.tasks": "待办",
  "nav.search": "全局搜索",
  "nav.settings": "设置",

  // ---- 登录 ----
  "login.recent": "最近登录",
  "login.noAccount": "未登录",
  "login.forget": "清除记录",
  "login.scheme": "协议",
  "login.errNoServer": "请填写服务器地址",
  "login.serverHint": "选择协议、填写主机和端口（端口可留空走默认值）",
  "login.title": "Nowen Note Lite",
  "login.subtitle": "连接你的私有知识库",
  "login.username": "用户名",
  "login.usernamePlaceholder": "请输入用户名",
  "login.password": "密码",
  "login.passwordPlaceholder": "请输入密码",
  "login.showPassword": "显示密码",
  "login.hidePassword": "隐藏密码",
  "login.remember": "记住我",
  "login.rememberHint": "关闭后，本次会话结束即退出登录",
  "login.submit": "登录",
  "login.submitting": "登录中…",
  "login.serverLabel": "服务器",
  "login.serverSameOrigin": "当前站点",
  "login.serverChange": "修改",
  "login.checking": "正在检查服务…",
  "login.serverOk": "服务正常",
  "login.serverFail": "连不上服务器",
  "login.serverFailHint": "请检查服务地址、网络，或确认 Nowen Note 服务正在运行。",

  "login.twoFactorTitle": "两步验证",
  "login.twoFactorSubtitle": "请输入身份验证器上的 6 位验证码",
  "login.twoFactorCode": "验证码",
  "login.twoFactorPlaceholder": "123456 / xxxxx-xxxxx",
  "login.twoFactorHint": "支持验证器动态码，或一枚一次性备用码",
  "login.twoFactorVerify": "验证",
  "login.twoFactorVerifying": "验证中…",
  "login.twoFactorBack": "返回上一步",
  "login.twoFactorAccount": "正在验证账号",

  "login.errEmpty": "请输入用户名和密码",
  "login.errEmptyCode": "请输入验证码",
  "login.errNetwork": "连不上服务器，请检查网络或服务地址",

  // ---- 设置 ----
  "conn.ok": "连接正常（{ms} ms），点击重测",
  "conn.fail": "连不上服务端，点击重试",
  "conn.checking": "正在检测连接…",
  "conn.idle": "尚未检测",
  "conn.offline": "离线",
  "settings.connBadge": "右上角显示连接状态",
  "settings.connBadgeDesc": "固定在右上角显示服务端延迟与可用性；点它可立即重测。关掉后仍会在「同步诊断」里看到。",
  "conflict.title": "冲突",
  "conflict.empty": "没有未解决的冲突。",
  "conflict.dismissAll": "全部标记已解决",
  "conflict.clear": "清空冲突记录",
  "conflict.versions": "本机 v{local} → 服务端 v{server}",
  "conflict.more": "还有 {n} 条…",
  "sync.diagnostics": "同步诊断",
  "sync.refresh": "刷新",
  "sync.deviceId": "设备标识",
  "sync.server": "服务端",
  "sync.localCursor": "本地缓存条目",
  "sync.pending": "待同步条目",
  "sync.conflicts": "未解决冲突",
  "sync.lastSync": "最近刷新",
  "sync.lastPing": "最近通信",
  "sync.lastError": "最近错误",
  "sync.none": "—",
  "sync.noError": "无",
  "sync.checking": "正在检查…",
  "sync.modeTitle": "数据来源",
  "sync.modeLive": "我的 Nowen Server",
  "sync.modeLiveDesc": "实时读写服务器，本机只保留一份缓存副本用于加速启动。这也是 Lite 唯一的正式模式。",
  "sync.modeOffline": "不同步，仅此设备",
  "sync.modeOfflineDesc": "Not implemented — Lite 是薄客户端，没有本地优先同步引擎；服务端不可达时它只能显示缓存副本。",
  "settings.title": "设置",
  "settings.group.account": "账号",
  "settings.group.appearance": "外观",
  "settings.group.notes": "笔记展示",
  "settings.group.sync": "同步与缓存",
  "settings.group.about": "关于",

  "settings.loginState": "登录状态",
  "settings.serverState": "服务端连接",
  "settings.stateOk": "已登录",
  "settings.stateExpired": "会话已失效",
  "settings.stateOffline": "无法确认",
  "settings.stateExpiredHint": "服务端不认这个登录凭证了，重新登录即可。",
  "settings.stateOfflineHint": "连不上服务端，暂时无法确认登录状态。检查网络或下面的服务器地址。",
  "settings.serverOk": "连接正常",
  "settings.serverFail": "连不上",
  "settings.serverFailHintLong": "打不开服务端的 /api/health。确认 Nowen Note 服务在运行、地址填写正确。",
  "settings.recheck": "重新检测",
  "settings.checking": "检测中…",
  "settings.checkedAt": "检测于 {time}",
  "settings.relogin": "重新登录",
  "settings.currentAccount": "当前账号",
  "settings.accountChecking": "查询中…",
  "settings.accountInvalid": "(会话已失效)",
  "settings.accountOffline": "(无法连接服务端)",
  "settings.logout": "退出登录",
  "settings.logoutConfirm": "退出后需要重新登录，本机缓存不会被删除。确定退出吗？",

  "settings.serverLabel": "服务器地址",
  "settings.serverPlaceholder": "留空 = 当前站点",
  "settings.serverHint": "例如 http://192.168.8.9:3002；留空＝与当前页面同源。",
  "settings.serverSaved": "已保存（重新登录后生效）",

  "settings.uiStyle": "界面风格",
  "settings.uiStyleDesc": "原生＝Nowen Note 标准版的样子（不透明表面、小圆角）；液态玻璃＝折射质感（大圆角、背景透光）。两者都能配深色模式。",
  "settings.styleNative": "原生",
  "settings.styleLiquid": "液态玻璃",
  "settings.theme": "外观模式",
  "settings.themeDesc": "深色模式会在夜间降低亮度对比。两套界面风格都单独调过，不是简单反色。",
  "settings.themeAuto": "跟随系统 · 当前系统是{system}",
  "settings.themeDark": "始终使用深色",
  "settings.themeLight": "始终使用浅色",
  "settings.dark": "深色",
  "settings.light": "浅色",
  "settings.auto": "跟随系统",

  "settings.language": "界面语言",
  "settings.languageDesc": "只影响界面文案，笔记内容不会被翻译。",

  "settings.fontSize": "编辑器默认字号",
  "settings.fontSizeDesc": "影响笔记正文、Markdown 源码与预览；只改变显示，不修改内容。",
  "settings.fontSizeDefault": "默认",

  "settings.notebooksDesc": "笔记页是扁平列表，这里决定哪些笔记本的笔记要出现在里面。取消勾选只是「不显示」，不会删除任何内容。",
  "settings.notebooksSummary": "已显示 {visible} / {total} 个笔记本，共 {notes} 篇笔记",
  "settings.notebooksEmptyCount": "（其中 {n} 个是空的）",
  "settings.notebookSearch": "搜索笔记本（共 {n} 个）",
  "settings.notebookNoMatch": "没有匹配「{kw}」的笔记本",
  "settings.hideEmpty": "隐藏 {n} 个空笔记本",
  "settings.showEmpty": "恢复显示空笔记本",
  "settings.showAll": "全部显示",

  "settings.cacheTitle": "本地缓存预加载",
  "settings.cacheDesc": "把笔记列表和最近打开的笔记正文缓存在本机：启动时秒出，打开笔记先显示缓存再后台刷新。缓存只是副本，删除不会影响服务器上的数据。",
  "settings.cacheEnable": "启用预加载",
  "settings.cacheCount": "预加载条数",
  "settings.cacheCountHint": "最近打开的多少篇笔记正文会被缓存在本机。",
  "settings.cacheUnit": "{n} 篇",
  "settings.cacheUsage": "缓存占用",
  "settings.cacheUsageValue": "{notes} 篇正文 · {size}",
  "settings.cacheEmpty": "暂无缓存",
  "settings.cacheClear": "清空缓存",
  "settings.cacheCleared": "缓存已清空",
  "settings.cacheBusy": "处理中…",

  "settings.tzTitle": "时区自检",
  "settings.tzDesc": "服务端存的时间统一是 UTC，显示时由本机换算。这里显示本机的换算基准。",
  "settings.tzName": "本机时区",
  "settings.tzOffset": "UTC 偏移",
  "settings.tzLocal": "本机时间",
  "settings.tzUtc": "UTC 时间",

  "settings.about": "Nowen Note Lite",
  "settings.aboutVersion": "v0.0.4",
  "settings.aboutDesc": "移动端极简客户端，与 Nowen Note 服务端共用同一账号与数据",
  "settings.aboutTech": "数据层：@nowen/sdk（MIT） · 未包含本地优先 / 离线同步",

  // ---- 笔记流 ----
  "notes.title": "笔记",
  "notes.searchPlaceholder": "搜索笔记",
  "notes.viewFlat": "仅看笔记",
  "notes.viewFolders": "文件夹排布",
  "notes.viewSwitchLabel": "笔记排布方式",
  "notes.newNote": "新建笔记",
  "notes.newNoteTo": "新建笔记到…",
  "notes.empty": "还没有笔记",
  "notes.emptySearch": "没有匹配「{kw}」的笔记",
  "notes.emptyFolders": "还没有文件夹",
  "notes.emptyScope": "这个文件夹里（含子文件夹）没有笔记",
  "notes.emptyVisible": "当前没有可见的笔记",
  "notes.hiddenHint": "已隐藏 {n} 个笔记本的笔记（去「设置 · 笔记展示」调整）",
  "notes.scopeAll": "显示全部笔记",
  "notes.unclassified": "未归类",
  "notes.pickerSearch": "搜索笔记本（共 {n} 个）",
  "notes.pickerNoMatch": "没有匹配「{kw}」的笔记本",
  "notes.pickerCount": "{n} 篇",

  // ---- 笔记阅读 / 编辑 ----
  "note.untitled": "无标题",
  "note.edit": "编辑",
  "note.pinned": "已置顶",
  "note.timeJustNow": "刚刚",
  "note.timeMinutes": "{n} 分钟前",
  "note.timeHours": "{n} 小时前",
  "note.timeDays": "{n} 天前",

  "editor.title": "编辑",
  "editor.readOnlyTitle": "只读",
  "editor.save": "保存",
  "editor.saving": "保存中…",
  "editor.preview": "预览",
  "editor.source": "源码",
  "editor.bold": "加粗",
  "editor.h1": "标题",
  "editor.list": "列表",
  "editor.quote": "引用",
  "editor.code": "代码",
  "editor.link": "链接",
  "editor.placeholder": "开始写…",
  "editor.tip": "支持 Markdown 语法；中文输入法下不会打断输入。",
  "editor.draftRestored": "已恢复上次未保存的草稿",
  "editor.unsavedTitle": "还没保存",
  "editor.unsavedMessage": "这篇笔记有未保存的修改，离开会丢失。",
  "editor.discard": "放弃修改",
  "editor.keepEditing": "继续编辑",
  "editor.conflictTitle": "这篇笔记被改过了",
  "editor.conflictMessage": "服务器上已有更新的版本（可能是其他设备改的）。你的修改还在编辑器里，可以先复制走。",
  "editor.overwrite": "覆盖服务器版本",
  "editor.reload": "载入服务器版本",
  "editor.htmlTip": "这是 HTML 笔记，按源码编辑。",

  // ---- 说说 ----
  "diary.edit": "编辑",
  "diary.delete": "删除",
  "diary.editing": "正在编辑",
  "diary.saveEdit": "保存修改",
  "diary.saving": "保存中…",
  "diary.cancelEdit": "取消编辑",
  "diary.deleteTitle": "删除这条说说？",
  "diary.deleteMessage": "删除后不可恢复，里面的图片也会一并删除。",
  "diary.deleteConfirm": "删除",
  "diary.deleting": "删除中…",
  "diary.deleted": "已删除",
  "diary.editFailed": "保存失败：{msg}",
  "diary.deleteFailed": "删除失败：{msg}",
  "diary.pureMedia": "（纯图片）",
  "diary.title": "日记说说",
  "diary.compose": "写说说",
  "diary.placeholder": "今天发生了什么？",
  "diary.publish": "发布",
  "diary.publishing": "发布中…",
  "diary.uploading": "上传中…",
  "diary.addMedia": "添加图片或视频",
  "diary.moodNone": "无",
  "diary.moodLabel": "心情 {m}",
  "diary.moodNoneLabel": "不选心情",
  "diary.empty": "还没有记录",
  "diary.loadMore": "加载更早的",
  "diary.today": "今天",
  "diary.yesterday": "昨天",
  "diary.beforeYesterday": "前天",
  "diary.count": "{n} 条",

  // ---- 待办 ----
  "tasks.title": "待办",
  "tasks.newTask": "新建待办",
  "tasks.newTaskTitle": "新建待办",
  "tasks.newTaskPlaceholder": "要做什么？",
  "tasks.filterOpen": "未完成",
  "tasks.filterDone": "已完成",
  "tasks.filterAll": "全部",
  "tasks.empty": "还没有待办",
  "tasks.emptyDone": "还没有完成的待办",
  "tasks.overdue": "已逾期",
  "tasks.due": "截止 {date}",
  "tasks.statOpen": "未完成",
  "tasks.statDone": "已完成",
  "tasks.statOverdue": "已逾期",
  "tasks.priorityHigh": "高",
  "tasks.priorityMedium": "中",
  "tasks.priorityLow": "低",

  // ---- 全局搜索 ----
  "search.title": "全局搜索",
  "search.placeholder": "搜索全部笔记…",
  "search.hint": "输入关键词，搜索你的全部笔记",
  "search.searching": "搜索中…",
  "search.empty": "没有找到匹配的笔记",
  "search.resultCount": "找到 {n} 条",
  "search.failed": "搜索失败",
};

const en: Dict = {
  "common.cancel": "Cancel",
  "common.confirm": "OK",
  "common.save": "Save",
  "common.saved": "Saved",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.empty": "Nothing here yet",
  "common.clear": "Clear",
  "common.all": "All",
  "common.default": "Default",
  "common.on": "On",
  "common.off": "Off",

  "notes.unnamedNotebook": "Unnamed notebook",
  "notes.scopeCount": " · {n} notes",
  "diary.viewImage": "View image {n}",
  "diary.removeMedia": "Remove {name}",
  "tasks.createFailed": "Create failed: {msg}",
  "tasks.toggleFailed": "Toggle failed, reverted: {msg}",
  "search.mindmapNote": "({n} more from mind maps/sheets — not shown in Lite)",
  "common.internalError": "The server did not return an id for the new note",
  "nav.notes": "Notes",
  "nav.diary": "Moments",
  "nav.tasks": "Tasks",
  "nav.search": "Search",
  "nav.settings": "Settings",

  "login.title": "Nowen Note Lite",
  "login.subtitle": "Connect to your private knowledge base",
  "login.recent": "Recent",
  "login.noAccount": "Not signed in",
  "login.forget": "Forget",
  "login.scheme": "Protocol",
  "login.errNoServer": "Enter the server address",
  "login.serverHint": "Pick a protocol and enter host and port (the port may be left at its default)",
  "login.username": "Username",
  "login.usernamePlaceholder": "Enter your username",
  "login.password": "Password",
  "login.passwordPlaceholder": "Enter your password",
  "login.showPassword": "Show password",
  "login.hidePassword": "Hide password",
  "login.remember": "Remember me",
  "login.rememberHint": "When off, you are signed out at the end of this session",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.serverLabel": "Server",
  "login.serverSameOrigin": "This site",
  "login.serverChange": "Change",
  "login.checking": "Checking the server…",
  "login.serverOk": "Server is reachable",
  "login.serverFail": "Cannot reach the server",
  "login.serverFailHint": "Check the server address and your network, and make sure Nowen Note is running.",

  "login.twoFactorTitle": "Two-factor authentication",
  "login.twoFactorSubtitle": "Enter the 6-digit code from your authenticator app",
  "login.twoFactorCode": "Code",
  "login.twoFactorPlaceholder": "123456 / xxxxx-xxxxx",
  "login.twoFactorHint": "An authenticator code, or one of your single-use backup codes",
  "login.twoFactorVerify": "Verify",
  "login.twoFactorVerifying": "Verifying…",
  "login.twoFactorBack": "Back to sign in",
  "login.twoFactorAccount": "Verifying account",

  "login.errEmpty": "Enter your username and password",
  "login.errEmptyCode": "Enter the verification code",
  "login.errNetwork": "Cannot reach the server. Check your network or server address.",

  "conn.ok": "Connected ({ms} ms) — tap to re-check",
  "conn.fail": "Cannot reach the server — tap to retry",
  "conn.checking": "Checking connection…",
  "conn.idle": "Not checked yet",
  "conn.offline": "Offline",
  "settings.connBadge": "Show connection status in the corner",
  "settings.connBadgeDesc": "Keeps latency and availability pinned to the top-right; tap it to re-check. Turning it off still leaves the data in Sync diagnostics.",
  "conflict.title": "Conflicts",
  "conflict.empty": "No unresolved conflicts.",
  "conflict.dismissAll": "Mark all resolved",
  "conflict.clear": "Clear conflict log",
  "conflict.versions": "local v{local} → server v{server}",
  "conflict.more": "{n} more…",
  "sync.diagnostics": "Sync diagnostics",
  "sync.refresh": "Refresh",
  "sync.deviceId": "Device ID",
  "sync.server": "Server",
  "sync.localCursor": "Cached notes",
  "sync.pending": "Pending items",
  "sync.conflicts": "Unresolved conflicts",
  "sync.lastSync": "Last refresh",
  "sync.lastPing": "Last contact",
  "sync.lastError": "Last error",
  "sync.none": "—",
  "sync.noError": "None",
  "sync.checking": "Checking…",
  "sync.modeTitle": "Data source",
  "sync.modeLive": "My Nowen Server",
  "sync.modeLiveDesc": "Reads and writes the server live; this device keeps only a cache copy to speed up startup. This is Lite's only real mode.",
  "sync.modeOffline": "No sync, this device only",
  "sync.modeOfflineDesc": "Not implemented — Lite is a thin client with no local-first sync engine; when the server is unreachable it can only show cached copies.",
  "settings.title": "Settings",
  "settings.group.account": "Account",
  "settings.group.appearance": "Appearance",
  "settings.group.notes": "Notes",
  "settings.group.sync": "Sync & cache",
  "settings.group.about": "About",

  "settings.loginState": "Sign-in status",
  "settings.serverState": "Server connection",
  "settings.stateOk": "Signed in",
  "settings.stateExpired": "Session expired",
  "settings.stateOffline": "Unknown",
  "settings.stateExpiredHint": "The server no longer accepts this credential — sign in again.",
  "settings.stateOfflineHint": "Cannot reach the server, so the sign-in state is unknown. Check your network or the server address below.",
  "settings.serverOk": "Connected",
  "settings.serverFail": "Unreachable",
  "settings.serverFailHintLong": "The server's /api/health did not respond. Make sure Nowen Note is running and the address is correct.",
  "settings.recheck": "Check again",
  "settings.checking": "Checking…",
  "settings.checkedAt": "Checked at {time}",
  "settings.relogin": "Sign in again",
  "settings.currentAccount": "Signed in as",
  "settings.accountChecking": "Checking…",
  "settings.accountInvalid": "(session expired)",
  "settings.accountOffline": "(cannot reach the server)",
  "settings.logout": "Sign out",
  "settings.logoutConfirm": "You will need to sign in again. Local cache is kept. Sign out?",

  "settings.serverLabel": "Server address",
  "settings.serverPlaceholder": "Empty = this site",
  "settings.serverHint": "e.g. http://192.168.8.9:3002; empty means same-origin.",
  "settings.serverSaved": "Saved (takes effect after signing in again)",

  "settings.uiStyle": "Interface style",
  "settings.uiStyleDesc": "Native matches the standard Nowen Note look (opaque surfaces, small radii); Liquid Glass adds refraction (large radii, translucent surfaces). Both work with dark mode.",
  "settings.styleNative": "Native",
  "settings.styleLiquid": "Liquid Glass",
  "settings.theme": "Appearance mode",
  "settings.themeDesc": "Dark mode lowers the contrast for night use. Both interface styles are tuned separately — not a plain inversion.",
  "settings.themeAuto": "Follow system · system is currently {system}",
  "settings.themeDark": "Always dark",
  "settings.themeLight": "Always light",
  "settings.dark": "Dark",
  "settings.light": "Light",
  "settings.auto": "System",

  "settings.language": "Interface language",
  "settings.languageDesc": "Affects interface text only; note content is never translated.",

  "settings.fontSize": "Default editor font size",
  "settings.fontSizeDesc": "Applies to note text, Markdown source and preview. Display only — your content is not modified.",
  "settings.fontSizeDefault": "Default",

  "settings.notebooksDesc": "The notes page is a flat list. Choose which notebooks contribute to it. Unchecking only hides — nothing is deleted.",
  "settings.notebooksSummary": "Showing {visible} of {total} notebooks · {notes} notes",
  "settings.notebooksEmptyCount": " ({n} empty)",
  "settings.notebookSearch": "Search notebooks ({n})",
  "settings.notebookNoMatch": "No notebook matches “{kw}”",
  "settings.hideEmpty": "Hide {n} empty notebooks",
  "settings.showEmpty": "Show empty notebooks",
  "settings.showAll": "Show all",

  "settings.cacheTitle": "Local cache preloading",
  "settings.cacheDesc": "Cache the note list and recently opened notes on this device: the app starts instantly, and a note opens from cache while it refreshes in the background. The cache is a copy — clearing it never touches your server data.",
  "settings.cacheEnable": "Enable preloading",
  "settings.cacheCount": "Preload count",
  "settings.cacheCountHint": "How many recently opened notes keep their content cached on this device.",
  "settings.cacheUnit": "{n} notes",
  "settings.cacheUsage": "Cache usage",
  "settings.cacheUsageValue": "{notes} note bodies · {size}",
  "settings.cacheEmpty": "Nothing cached yet",
  "settings.cacheClear": "Clear cache",
  "settings.cacheCleared": "Cache cleared",
  "settings.cacheBusy": "Working…",

  "settings.tzTitle": "Timezone check",
  "settings.tzDesc": "The server stores all times in UTC; this device converts them for display. These are the values it uses.",
  "settings.tzName": "Device timezone",
  "settings.tzOffset": "UTC offset",
  "settings.tzLocal": "Local time",
  "settings.tzUtc": "UTC time",

  "settings.about": "Nowen Note Lite",
  "settings.aboutVersion": "v0.0.4",
  "settings.aboutDesc": "A minimal mobile client sharing the same account and data as your Nowen Note server",
  "settings.aboutTech": "Data layer: @nowen/sdk (MIT) · no local-first / offline sync",

  "notes.title": "Notes",
  "notes.searchPlaceholder": "Search notes",
  "notes.viewFlat": "Notes",
  "notes.viewFolders": "Folders",
  "notes.viewSwitchLabel": "Note layout",
  "notes.newNote": "New note",
  "notes.newNoteTo": "New note in…",
  "notes.empty": "No notes yet",
  "notes.emptySearch": "No note matches “{kw}”",
  "notes.emptyFolders": "No folders yet",
  "notes.emptyScope": "This folder (including subfolders) has no notes",
  "notes.emptyVisible": "No visible notes",
  "notes.hiddenHint": "{n} notebooks are hidden (change this in Settings · Notes)",
  "notes.scopeAll": "Show all notes",
  "notes.unclassified": "Unfiled",
  "notes.pickerSearch": "Search notebooks ({n})",
  "notes.pickerNoMatch": "No notebook matches “{kw}”",
  "notes.pickerCount": "{n}",

  "note.untitled": "Untitled",
  "note.edit": "Edit",
  "note.pinned": "Pinned",
  "note.timeJustNow": "just now",
  "note.timeMinutes": "{n} min ago",
  "note.timeHours": "{n} h ago",
  "note.timeDays": "{n} d ago",

  "editor.title": "Edit",
  "editor.readOnlyTitle": "Read only",
  "editor.save": "Save",
  "editor.saving": "Saving…",
  "editor.preview": "Preview",
  "editor.source": "Source",
  "editor.bold": "Bold",
  "editor.h1": "Heading",
  "editor.list": "List",
  "editor.quote": "Quote",
  "editor.code": "Code",
  "editor.link": "Link",
  "editor.placeholder": "Start writing…",
  "editor.tip": "Markdown is supported; typing is never interrupted by the IME.",
  "editor.draftRestored": "Restored your unsaved draft",
  "editor.unsavedTitle": "Unsaved changes",
  "editor.unsavedMessage": "This note has unsaved changes that will be lost if you leave.",
  "editor.discard": "Discard",
  "editor.keepEditing": "Keep editing",
  "editor.conflictTitle": "This note changed elsewhere",
  "editor.conflictMessage": "The server has a newer version (edited on another device). Your changes are still in the editor — copy them first if needed.",
  "editor.overwrite": "Overwrite server version",
  "editor.reload": "Load server version",
  "editor.htmlTip": "This is an HTML note, edited as source.",

  "diary.edit": "Edit",
  "diary.delete": "Delete",
  "diary.editing": "Editing",
  "diary.saveEdit": "Save changes",
  "diary.saving": "Saving…",
  "diary.cancelEdit": "Cancel",
  "diary.deleteTitle": "Delete this moment?",
  "diary.deleteMessage": "This cannot be undone — its media is deleted too.",
  "diary.deleteConfirm": "Delete",
  "diary.deleting": "Deleting…",
  "diary.deleted": "Deleted",
  "diary.editFailed": "Save failed: {msg}",
  "diary.deleteFailed": "Delete failed: {msg}",
  "diary.pureMedia": "(media only)",
  "diary.title": "Moments",
  "diary.compose": "New moment",
  "diary.placeholder": "What happened today?",
  "diary.publish": "Post",
  "diary.publishing": "Posting…",
  "diary.uploading": "Uploading…",
  "diary.addMedia": "Add photo or video",
  "diary.moodNone": "None",
  "diary.moodLabel": "Mood {m}",
  "diary.moodNoneLabel": "No mood",
  "diary.empty": "Nothing here yet",
  "diary.loadMore": "Load earlier",
  "diary.today": "Today",
  "diary.yesterday": "Yesterday",
  "diary.beforeYesterday": "2 days ago",
  "diary.count": "{n}",

  "tasks.title": "Tasks",
  "tasks.newTask": "New task",
  "tasks.newTaskTitle": "New task",
  "tasks.newTaskPlaceholder": "What needs doing?",
  "tasks.filterOpen": "Open",
  "tasks.filterDone": "Done",
  "tasks.filterAll": "All",
  "tasks.empty": "No tasks yet",
  "tasks.emptyDone": "Nothing completed yet",
  "tasks.overdue": "Overdue",
  "tasks.due": "Due {date}",
  "tasks.statOpen": "Open",
  "tasks.statDone": "Done",
  "tasks.statOverdue": "Overdue",
  "tasks.priorityHigh": "High",
  "tasks.priorityMedium": "Medium",
  "tasks.priorityLow": "Low",

  "search.title": "Search",
  "search.placeholder": "Search all notes…",
  "search.hint": "Type a keyword to search across all your notes",
  "search.searching": "Searching…",
  "search.empty": "No matching notes",
  "search.resultCount": "{n} results",
  "search.failed": "Search failed",
};

const DICTS: Record<Lang, Dict> = { "zh-CN": zh, en };

function detectLang(): Lang {
  try {
    const raw = localStorage.getItem(LANG_KEY);
    if (raw === "zh-CN" || raw === "en") return raw;
  } catch {
    /* 隐私模式 */
  }
  // 没设置过就跟浏览器语言
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

let current: Lang = detectLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* 隐私模式：不记住，但本次生效 */
  }
  try {
    document.documentElement.lang = next;
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 取文案。缺 key 时回落到中文，中文也没有就返回 key 本身
 * —— 开发时一眼看得见漏了哪条，不会静默显示空白。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? zh[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name]),
  );
}

/**
 * 订阅语言变化。返回 `[lang, t]`：
 *   const { lang, t } = useI18n();
 * 语言一变，用到它的组件自动重渲染。
 */
export function useI18n(): { lang: Lang; t: typeof t } {
  const [lang, setLangState] = useState<Lang>(current);
  useEffect(() => subscribeLang(() => setLangState(current)), []);
  // t 本身不依赖 lang（它读 module 级 current），用 useCallback 稳住引用即可
  const translate = useCallback<typeof t>((key, vars) => t(key, vars), [lang]);
  return { lang, t: translate };
}
