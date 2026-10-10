export interface NoteIconGroup {
  id: string;
  label: string;
  keywords: string[];
  icons: string[];
}

export const NOTE_ICON_GROUPS: NoteIconGroup[] = [
  { id: "writing", label: "笔记与写作", keywords: ["note", "writing", "学习", "记录", "文档"], icons: ["📝","📌","📍","📎","📚","📖","📕","📗","📘","📙","📓","📔","📒","📑","🔖","✏️","✍️","🖊️","🖋️","📋","📄","📃","🗒️","🗂️"] },
  { id: "ideas", label: "灵感与目标", keywords: ["idea", "goal", "灵感", "目标", "计划"], icons: ["💡","🎯","⭐","🌟","✨","🔥","🚀","🧠","🧩","🪄","🔭","🧭","🏆","🥇","📈","💎","🔑","✅","☑️","💯"] },
  { id: "work", label: "工作与效率", keywords: ["work", "office", "工作", "办公", "效率"], icons: ["💼","📊","📉","📅","🗓️","⏰","⏱️","⌛","📦","🗃️","🗄️","📁","📂","🧾","💰","💳","🤝","📣","📢","☎️"] },
  { id: "tech", label: "开发与科技", keywords: ["tech", "code", "dev", "开发", "代码", "科技"], icons: ["💻","🖥️","⌨️","🖱️","📱","🧑‍💻","👨‍💻","👩‍💻","⚙️","🛠️","🔧","🔨","🧰","🧪","🔬","🤖","💾","💿","📡","🔌","🔋","🌐","🔗","🛰️"] },
  { id: "communication", label: "沟通与社交", keywords: ["chat", "social", "沟通", "社交", "消息"], icons: ["💬","🗨️","🗯️","💭","📨","📩","✉️","📧","📮","🔔","📞","🎙️","🎤","👥","🫂","🙋","🤝","❤️","💜","💙"] },
  { id: "life", label: "生活", keywords: ["life", "home", "生活", "家庭", "日常"], icons: ["🏠","🏡","🛋️","🛏️","🚿","🧹","🧺","🛒","🛍️","☕","🍵","🥤","🍽️","🍳","🥗","🍜","🍕","🍰","🎂","🌞","🌙","☔","❄️","🌈"] },
  { id: "health", label: "健康与运动", keywords: ["health", "sport", "健康", "运动", "健身"], icons: ["🏃","🚶","🏋️","🚴","🏊","🧘","⚽","🏀","🏸","🎾","🏓","🥊","🏅","💪","❤️‍🔥","🫀","🩺","💊","🥦","🍎"] },
  { id: "travel", label: "旅行与地点", keywords: ["travel", "place", "旅行", "地点", "交通"], icons: ["🌍","🌎","🌏","🗺️","🏔️","⛰️","🏕️","🏖️","🏝️","🏙️","🌆","✈️","🚄","🚗","🚲","🚢","🧳","📷","🗼","🏛️"] },
  { id: "nature", label: "自然", keywords: ["nature", "自然", "植物", "动物"], icons: ["🌱","🌿","🍀","🌵","🌲","🌳","🌴","🌷","🌸","🌻","🌹","🍁","🍂","🐱","🐶","🐼","🦊","🦁","🐳","🦋","🐝","🐦","🐟","🐢"] },
  { id: "creative", label: "创作与娱乐", keywords: ["creative", "music", "art", "创作", "娱乐", "音乐"], icons: ["🎨","🖌️","🖼️","🎵","🎶","🎧","🎹","🎸","🎻","🥁","🎬","🎞️","📺","🎮","🕹️","🎲","♟️","📸","🎭","🎪"] },
  { id: "status", label: "状态与标记", keywords: ["status", "flag", "状态", "标记", "优先级"], icons: ["🔴","🟠","🟡","🟢","🔵","🟣","⚪","⚫","❗","❓","⚠️","🚫","⛔","✔️","❌","➕","➖","⬆️","⬇️","➡️","🔒","🔓","📌","🚩"] },
  { id: "symbols", label: "符号", keywords: ["symbol", "符号", "分类"], icons: ["♻️","∞","©️","™️","➰","➿","〽️","✳️","✴️","❇️","🔆","🔅","💠","🔷","🔶","🔹","🔸","▪️","▫️","◾","◽","🔳","🔲","🆕"] },
];

export const ALL_NOTE_ICONS = Array.from(
  new Set(NOTE_ICON_GROUPS.flatMap((group) => group.icons)),
);

export function searchNoteIcons(query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return ALL_NOTE_ICONS;
  const matchedGroups = NOTE_ICON_GROUPS.filter((group) => (
    group.label.toLocaleLowerCase().includes(normalized)
    || group.id.includes(normalized)
    || group.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(normalized))
  ));
  const direct = ALL_NOTE_ICONS.filter((icon) => icon.includes(normalized));
  return Array.from(new Set([...direct, ...matchedGroups.flatMap((group) => group.icons)]));
}

export interface VirtualIconRows {
  startRow: number;
  endRow: number;
  totalRows: number;
}

export function getVirtualIconRows(
  totalIcons: number,
  scrollTop: number,
  viewportHeight: number,
  columns = 8,
  rowHeight = 44,
  overscan = 2,
): VirtualIconRows {
  const safeColumns = Math.max(1, Math.trunc(columns));
  const safeRowHeight = Math.max(1, rowHeight);
  const totalRows = Math.ceil(Math.max(0, totalIcons) / safeColumns);
  const first = Math.floor(Math.max(0, scrollTop) / safeRowHeight);
  const visibleRows = Math.ceil(Math.max(1, viewportHeight) / safeRowHeight);
  return {
    startRow: Math.max(0, first - overscan),
    endRow: Math.min(totalRows, first + visibleRows + overscan),
    totalRows,
  };
}
