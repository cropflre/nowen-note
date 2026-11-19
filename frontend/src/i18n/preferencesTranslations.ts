// Settings → Preferences (使用偏好). Keep zh-CN and en key-for-key identical.
export const zhCNPreferencesTranslations = {
  settings: { preferences: "使用偏好" },
  preferences: {
    title: "使用偏好",
    description: "常用设置放在首页，其余按场景分类，修改后立即生效。",
    searchPlaceholder: "搜索设置，例如：标签页、代码块",
    searchLabel: "搜索使用偏好",
    clearSearch: "清除搜索",
    resultsLabel: "搜索结果",
    resultCount: "找到 {{count}} 项设置",
    noResults: "没有找到与「{{query}}」相关的设置",
    back: "使用偏好",
    backLabel: "返回使用偏好",
    common: "常用",
    more: "更多设置",
    moreOptions: "更多选项",
    editingMoreSummary: "代码块换行与折叠、打开笔记时锁定",
    manage: "管理",
    goTo: "前往",
    saveFailed: "保存失败，已恢复原设置",
    saveFailedReason: "保存失败，已恢复原设置：{{reason}}",
    syncOffHint: "当前未开启同步：标有「账号同步」的设置先保存在本机，开启同步后随账号保存。",
    localModeHint: "仅此设备模式：所有偏好只保存在这台设备上。",
    scope: {
      account: "账号同步",
      accountHint: "保存到账号，在登录同一账号的设备间同步",
      device: "仅本设备",
      deviceHint: "只保存在当前设备，不随账号同步",
      admin: "管理员",
      adminHint: "服务器设置，对所有成员生效，仅管理员可以修改",
    },
    categories: {
      navigation: {
        title: "导航与模块",
        summary: "已显示 {{visible}}/{{total}} 个导航模块",
        description: "选择侧栏显示哪些入口并调整顺序。隐藏不会删除数据，通过链接仍可直接打开。",
      },
      editing: {
        title: "编辑与阅读",
        summary: "Markdown、图片粘贴、大纲和代码块",
        description: "笔记的打开方式和编辑习惯。只改变显示与默认行为，不修改笔记内容。",
      },
      layout: {
        title: "界面与布局",
        summary: "侧栏入口、笔记列表和本设备布局",
        description: "调整界面元素。「此设备」中的选项只作用于当前设备。",
      },
      advanced: {
        title: "高级选项",
        summary: "日记隐私和管理员设置",
        description: "这些设置已移到更合适的位置，选择后直接前往。",
      },
    },
    sections: {
      navigationModules: "导航模块",
      navigationHint: "拖动或使用上下箭头调整顺序",
      taskCenter: "任务中心模块",
      taskCenterSummary: "已显示 {{visible}}/{{total}}",
      taskCenterDescription: "任务列表始终保留，其余模块可按需隐藏。",
      general: "通用",
      thisDeviceMobile: "此设备 · 手机布局",
      thisDeviceDesktop: "此设备 · 桌面布局",
      privacy: "隐私",
      admin: "管理员",
    },
    navigation: {
      moveUp: "上移「{{name}}」",
      moveDown: "下移「{{name}}」",
      dragHandle: "拖动以调整「{{name}}」的位置",
    },
    items: {
      enableNoteTabs: {
        title: "笔记标签页",
        description: "在编辑区顶部用标签页切换已打开的笔记。",
        keywords: "标签 多标签 切换 tab tabs",
      },
      markdownDefaultViewMode: {
        title: "Markdown 默认打开方式",
        description: "打开 Markdown 笔记时使用源码、预览或分屏。",
        keywords: "md 源码 预览 分屏 视图 编辑器",
      },
      remoteImagePasteMode: {
        title: "粘贴外部图片",
        description: "保存为附件可避免外链失效；转存失败时保留原链接。",
        keywords: "图片 外链 链接 附件 粘贴 复制 网页",
      },
      outlineDefaultOpen: {
        title: "默认显示大纲",
        description: "打开笔记时自动展开右侧大纲，仍可随时收起。",
        keywords: "大纲 目录 标题 toc",
      },
      codeBlockWordWrap: {
        title: "代码块自动换行",
        description: "关闭后保留原始行，长行可左右滑动查看。只影响显示。",
        keywords: "代码 换行 code wrap",
      },
      codeBlockCollapseMode: {
        title: "代码块默认展示",
        description: "「长代码折叠」会折叠 20 行及以上的代码块。只影响显示。",
        keywords: "代码 折叠 展开 code fold",
      },
      lockOnOpen: {
        title: "打开笔记时锁定",
        description: "已有笔记以只读方式打开，解锁后才能编辑；新建的笔记首次打开可直接编辑。",
        keywords: "锁定 只读 解锁 防误改 lock readonly",
      },
      showTemplateManagement: {
        title: "模板管理入口",
        description: "在侧栏显示模板管理，关闭后可随时重新开启。",
        keywords: "模板 template",
      },
      noteTitleAsAppTitle: {
        title: "窗口标题显示笔记名",
        description: "浏览器标签页和桌面窗口显示「笔记标题 - 站点名」。",
        keywords: "窗口 标题 浏览器 标签页 title",
      },
      showNoteListDividers: {
        title: "笔记列表分割线",
        description: "在相邻笔记之间显示细线，长列表更容易区分。",
        keywords: "分割线 分隔线 列表 divider",
      },
      mobileRailHidden: {
        title: "隐藏快捷栏",
        description: "打开目录时隐藏左侧快捷图标，让目录铺满屏幕。",
        keywords: "手机 移动端 快捷栏 图标 rail",
      },
      mobileKnowledgeTreeMode: {
        title: "树形目录",
        description: "关闭时优先显示最近文档，并逐层浏览全部内容。",
        keywords: "手机 移动端 目录 树 知识树",
      },
      mobileKnowledgeTreeCompact: {
        title: "目录紧凑模式",
        description: "保持小字号，并加大行距和按钮间距，减少误触。",
        keywords: "手机 移动端 紧凑 行距 误触",
      },
      desktopKnowledgeTreeMode: {
        title: "快捷浏览",
        description: "侧栏提供「最近 / 全部」入口；关闭时使用可拖拽整理的树形目录。",
        keywords: "桌面 电脑 目录 最近 全部 树",
      },
      desktopHideMenuBar: {
        keywords: "菜单 菜单栏 alt windows linux",
      },
      navigation: {
        keywords: "侧栏 导航 入口 模块 隐藏 排序 拖拽",
      },
      taskCenter: {
        keywords: "任务 待办 模块 隐藏",
      },
      journalPrivacy: {
        description: "日记密码，以及进入日记时是否重新解锁",
        keywords: "日记 密码 隐私 锁 解锁",
      },
      aiMemoryArchive: {
        description: "为整个服务器开启或关闭 AI 对话归档",
        keywords: "AI 对话 归档 记忆 ChatGPT 豆包 浏览器扩展",
      },
      webUi: {
        title: "网页端访问",
        description: "关闭浏览器访问网页端，服务器只保留 API",
        keywords: "网页 网页端 浏览器 API 访问 关闭",
      },
    },
  },
};

export const enPreferencesTranslations = {
  settings: { preferences: "Preferences" },
  preferences: {
    title: "Preferences",
    description: "Common settings come first; the rest are grouped by task. Changes apply right away.",
    searchPlaceholder: "Search settings, e.g. tabs, code blocks",
    searchLabel: "Search preferences",
    clearSearch: "Clear search",
    resultsLabel: "Search results",
    resultCount: "Settings found: {{count}}",
    noResults: "No settings match “{{query}}”",
    back: "Preferences",
    backLabel: "Back to Preferences",
    common: "Common",
    more: "More settings",
    moreOptions: "More options",
    editingMoreSummary: "Code wrapping and folding, lock notes on open",
    manage: "Manage",
    goTo: "Open",
    saveFailed: "Couldn't save. The previous setting was restored.",
    saveFailedReason: "Couldn't save, so the previous setting was restored: {{reason}}",
    syncOffHint: "Sync is off: settings marked “Synced” are kept on this device and saved to your account once sync is on.",
    localModeHint: "Device-only mode: all preferences stay on this device.",
    scope: {
      account: "Synced",
      accountHint: "Saved to your account and synced to devices signed in to it",
      device: "This device",
      deviceHint: "Stored only on this device and not synced",
      admin: "Admin",
      adminHint: "Server setting for everyone; only administrators can change it",
    },
    categories: {
      navigation: {
        title: "Navigation & modules",
        summary: "{{visible}} of {{total}} navigation modules shown",
        description: "Choose which entries appear in the sidebar and their order. Hiding never deletes data, and links still open.",
      },
      editing: {
        title: "Editing & reading",
        summary: "Markdown, image paste, outline, code blocks",
        description: "How notes open and behave while you edit. Display and defaults only; note content never changes.",
      },
      layout: {
        title: "Interface & layout",
        summary: "Sidebar entries, note list, this device's layout",
        description: "Adjust interface elements. Options under “This device” apply to this device only.",
      },
      advanced: {
        title: "Advanced",
        summary: "Journal privacy and admin settings",
        description: "These settings now live in a better place. Select one to go there.",
      },
    },
    sections: {
      navigationModules: "Navigation modules",
      navigationHint: "Drag or use the arrows to reorder",
      taskCenter: "Task Center modules",
      taskCenterSummary: "{{visible}} of {{total}} shown",
      taskCenterDescription: "The task list always stays. Hide the other modules you don't use.",
      general: "General",
      thisDeviceMobile: "This device · Phone layout",
      thisDeviceDesktop: "This device · Desktop layout",
      privacy: "Privacy",
      admin: "Administration",
    },
    navigation: {
      moveUp: "Move {{name}} up",
      moveDown: "Move {{name}} down",
      dragHandle: "Drag to reorder {{name}}",
    },
    items: {
      enableNoteTabs: {
        title: "Note tabs",
        description: "Switch between open notes with tabs above the editor.",
        keywords: "tab tabs switch multiple",
      },
      markdownDefaultViewMode: {
        title: "Default Markdown view",
        description: "Open Markdown notes in source, preview or split view.",
        keywords: "md source preview split editor",
      },
      remoteImagePasteMode: {
        title: "Paste external images",
        description: "Saving as attachments avoids broken links; images that fail to save keep their links.",
        keywords: "image picture link url attachment paste copy web",
      },
      outlineDefaultOpen: {
        title: "Show outline by default",
        description: "Expand the outline when a note opens. You can still close it.",
        keywords: "outline toc headings contents",
      },
      codeBlockWordWrap: {
        title: "Wrap code-block lines",
        description: "When off, lines keep their shape and long ones scroll sideways. Display only.",
        keywords: "code wrap lines",
      },
      codeBlockCollapseMode: {
        title: "Code-block display",
        description: "“Collapse long” folds code blocks of 20 or more lines. Display only.",
        keywords: "code fold collapse expand",
      },
      lockOnOpen: {
        title: "Lock notes on open",
        description: "Existing notes open read-only until you unlock them; a new note is editable the first time it opens.",
        keywords: "lock readonly read-only unlock",
      },
      showTemplateManagement: {
        title: "Template management",
        description: "Show template management in the sidebar. Turn it back on at any time.",
        keywords: "template templates",
      },
      noteTitleAsAppTitle: {
        title: "Note title in window title",
        description: "Browser tabs and desktop windows show “Note title - Site name”.",
        keywords: "window title browser tab",
      },
      showNoteListDividers: {
        title: "Note-list dividers",
        description: "Draw a thin line between notes so long lists are easier to scan.",
        keywords: "divider separator list lines",
      },
      mobileRailHidden: {
        title: "Hide shortcut bar",
        description: "Hide the left shortcut icons while the tree is open so it fills the screen.",
        keywords: "phone mobile shortcut rail icons",
      },
      mobileKnowledgeTreeMode: {
        title: "Tree view",
        description: "When off, recent documents come first and you browse All one level at a time.",
        keywords: "phone mobile tree folders",
      },
      mobileKnowledgeTreeCompact: {
        title: "Compact tree",
        description: "Keep the small text but add row and button spacing to avoid mis-taps.",
        keywords: "phone mobile compact spacing",
      },
      desktopKnowledgeTreeMode: {
        title: "Quick browse",
        description: "Browse Recent and All in the sidebar. When off, use the tree with drag-and-drop organization.",
        keywords: "desktop computer recent all tree folders",
      },
      desktopHideMenuBar: {
        keywords: "menu menubar alt windows linux",
      },
      navigation: {
        keywords: "sidebar navigation entries modules hide show order reorder drag",
      },
      taskCenter: {
        keywords: "tasks todo modules hide",
      },
      journalPrivacy: {
        description: "Journal password and unlocking again on entry",
        keywords: "journal diary password privacy lock unlock",
      },
      aiMemoryArchive: {
        description: "Turn the AI conversation archive on or off for the whole server",
        keywords: "ai conversation chat archive memory chatgpt doubao extension",
      },
      webUi: {
        title: "Web UI access",
        description: "Turn off browser access to the web app and keep only the API",
        keywords: "web browser api access disable",
      },
    },
  },
};
