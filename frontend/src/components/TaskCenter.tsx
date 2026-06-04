import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, Calendar, Plus, ListTodo,
  CalendarDays, AlertTriangle, CheckCheck, Inbox, X,
  Trash2, ImagePlus, Link as LinkIcon, ExternalLink, Loader2,
  User as UserIcon
} from "lucide-react";
import { format, isToday, isPast, isTomorrow, isThisWeek, parseISO, parse } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace } from "@/lib/api";
import { Task, TaskFilter, TaskPriority, TaskStats, Tag } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useApp } from "@/store/AppContext";
import GenericTagInput from "@/components/GenericTagInput";
import MentionPicker, { useMentionState, replaceMentionText } from "@/components/MentionPicker";
import TaskCalendar from "@/components/TaskCalendar";
import { syncTaskNotification, syncAllTaskNotifications } from "@/hooks/useCapacitor";

/* ===========================================================================
 * 任务标题富文本协议
 * ---------------------------------------------------------------------------
 * 为了零侵入向后兼容，task.title 仍然是 **纯字符串**，但允许内嵌两种 markdown
 * 风格的 token：
 *
 *   - 图片：![alt](/api/task-attachments/<id>)
 *           渲染时按 token 拆段：列表里显示 28×28 缩略图，详情里显示完整图片。
 *
 *   - 链接：[text](https://...) 或裸 URL（粘贴时自动包成 markdown 链接形式，
 *           text 默认为 hostname 让显示更紧凑）。
 *
 * 老数据没有任何 token —— parser 命中 0 个 match，退回单段纯文本，行为完全
 * 等价于改造前。
 * ========================================================================= */

type Token =
  | { kind: "text"; value: string }
  | { kind: "image"; alt: string; url: string }
  | { kind: "link"; text: string; url: string };

// markdown 图片 + 链接 + 裸 URL 的合并正则。
// 顺序：image > link > raw URL。先匹到优先级高的。
//
// 注意：[^\]]* 与 [^)]* 都禁止换行，避免吞掉跨行内容。
const TOKEN_RE = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s)]+)/g;

export function parseTaskTitle(title: string): Token[] {
  if (!title) return [];
  const out: Token[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // exec + 显式 lastIndex 才能拿到 match.index，比 replace+回调更适合
  // "需要原文 slice" 的拆段场景
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(title)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", value: title.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      // 图片
      out.push({ kind: "image", alt: m[1], url: m[2] });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      // markdown 链接
      out.push({ kind: "link", text: m[3], url: m[4] });
    } else if (m[5]) {
      // 裸 URL：text 用 hostname 紧凑显示
      out.push({ kind: "link", text: hostnameOf(m[5]), url: m[5] });
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < title.length) {
    out.push({ kind: "text", value: title.slice(lastIndex) });
  }
  return out;
}

/** 把 URL 截成 hostname；解析失败时退回截短的原串，避免抛异常打破 UI。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.length > 24 ? url.slice(0, 24) + "…" : url;
  }
}

/** 朴素的 URL 检测：用于 onPaste 时判断是否要转 markdown 链接。 */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/* ===== 富文本渲染：列表里"紧凑模式"，详情里"完整模式" ===== */
function TitleView({
  title,
  compact,
  isCompleted,
}: {
  title: string;
  compact: boolean;
  isCompleted: boolean;
}) {
  const { t } = useTranslation();
  const tokens = parseTaskTitle(title);
  // 没有任何 token（纯文本场景）走快速路径，行为与改造前一致
  if (tokens.length === 1 && tokens[0].kind === "text") {
    return <>{tokens[0].value}</>;
  }

  return (
    <span className="inline">
      {tokens.map((tok, i) => {
        if (tok.kind === "text") {
          return <React.Fragment key={i}>{tok.value}</React.Fragment>;
        }
        if (tok.kind === "image") {
          // 紧凑模式（列表）：28×28 圆角缩略图，行内显示，不撑高任务行；
          // 完整模式（详情）：最大 240px 高度，可点击放大（这里简单交给浏览器原生右键）
          return compact ? (
            <img
              key={i}
              src={tok.url}
              alt={tok.alt}
              className="inline-block align-middle w-7 h-7 mx-0.5 rounded object-cover border border-app-border bg-app-elevated"
              loading="lazy"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              key={i}
              src={tok.url}
              alt={tok.alt}
              className="block my-2 max-w-full max-h-[240px] rounded-md border border-app-border object-contain bg-app-elevated"
              loading="lazy"
            />
          );
        }
        // link：紧凑模式 = 圆角胶囊 + 图标，只显 hostname；完整模式 = 完整文本
        const display = compact ? hostnameOf(tok.url) : tok.text;
        return (
          <a
            key={i}
            href={tok.url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('tasks.openLink') + ': ' + tok.url}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex items-center gap-1 align-middle mx-0.5 px-1.5 py-0.5 rounded-md text-xs",
              "bg-app-hover/60 text-accent-primary hover:bg-app-active hover:underline",
              // 移动端窄视口下把 hostname 胶囊收紧到 120px，避免与中文标题挤一行时把 TaskRow 撑超视口；
              // 桌面端（md:）保持 160px。max-w-full 兜底：链接永远不超过父容器宽度。
              "max-w-[120px] md:max-w-[160px] truncate",
              isCompleted && "opacity-70"
            )}
          >
            <LinkIcon size={10} className="shrink-0" />
            <span className="truncate">{display}</span>
            {!compact && <ExternalLink size={10} className="shrink-0 opacity-60" />}
          </a>
        );
      })}
    </span>
  );
}

/* ===== 日期显示 =====
 *
 * dueDate 在数据库里以 'YYYY-MM-DD' 字符串存储（前端 <input type="date">
 * 直出，无时间分量、无时区）。
 *
 * 注意：date-fns 的 parseISO('YYYY-MM-DD') 会按 ISO-8601 规范当 UTC 0 点解析，
 * 而 isToday/isTomorrow/isThisWeek/isPast 全部按 **本地时区** 比较——这会
 * 导致东八区"今日新增"的待办在 UI 上显示成"逾期/明天/未到期"等错位现象。
 *
 * 因此对 'YYYY-MM-DD' 必须显式按本地时区构造（parse 三参数版本），让 Date
 * 落在本地 00:00:00；其它形态（含时间/Z 后缀的 ISO）继续走 parseISO。
 */
function toLocalDate(dateStr: string): Date {
  // 形如 '2024-05-01' 的纯日期字符串：按本地时区 00:00 构造
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return parse(dateStr, "yyyy-MM-dd", new Date());
  }
  // 其它形态按 ISO 解析（含时间分量 / 已带时区信息）
  return parseISO(dateStr);
}

function DateBadge({ dateStr }: { dateStr: string | null }) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  if (!dateStr) return null;
  const date = toLocalDate(dateStr);
  let className = "text-tx-tertiary";
  let text = format(date, "MM/dd", { locale: dateLocale });

  if (isToday(date)) {
    className = "text-green-500";
    text = t('tasks.today');
  } else if (isTomorrow(date)) {
    className = "text-accent-primary";
    text = t('tasks.tomorrow');
  } else if (isPast(date)) {
    className = "text-red-500";
    text = t('tasks.overdue') + " " + format(date, "MM/dd");
  } else if (isThisWeek(date, { weekStartsOn: 1 })) {
    text = format(date, "EEEE", { locale: dateLocale });
  }

  return (
    <span className={cn("flex items-center gap-1 text-xs whitespace-nowrap", className)}>
      <Calendar size={12} />
      {text}
    </span>
  );
}

/* ===== 任务项组件 ===== */
const TaskRow = React.forwardRef<HTMLDivElement, {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
}>(({ task, onToggle, onSelect, onDelete }, ref) => {
  const { t } = useTranslation();
  const isCompleted = task.isCompleted === 1;
  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t('tasks.high'), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t('tasks.medium'), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t('tasks.low'), color: "text-blue-400", flagClass: "text-blue-400" },
  };
  const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];
  // 工作区视图下任务可由不同成员创建，标题下面加一行 creator 徽标；
  // 个人空间下创建者一定是自己，省略。
  const showCreator =
    !!task.creatorName && getCurrentWorkspace() !== "personal";

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
      className={cn(
        // 关键：
        // 1) `min-w-0` + `w-full` —— 阻止 flex 子项因为内容过长把容器撑破
        //    (flex item 默认 min-width:auto，会让内部长 URL / 长中文无间断串
        //     把整行撑到视口外，导致右侧徽标被挤没、出现横向滚动)
        // 2) `items-start` —— 允许标题多行展示时，checkbox / 徽标对齐到首行顶端，
        //    比 items-center 在多行场景下视觉更稳
        "group flex items-start gap-3 w-full min-w-0 px-4 py-3 rounded-lg border transition-all cursor-pointer",
        isCompleted
          ? "border-transparent bg-app-hover/50 opacity-60"
          : "border-app-border bg-app-elevated hover:shadow-md hover:border-accent-primary/30"
      )}
      onClick={() => onSelect(task)}
    >
      {/* Checkbox —— 多行场景用 mt-0.5 把它轻微下压，与首行文字基线对齐 */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
        className="flex-shrink-0 mt-0.5 transition-transform hover:scale-110"
      >
        {isCompleted ? (
          <CheckCircle2 className="w-5 h-5 text-indigo-500" />
        ) : (
          <Circle className="w-5 h-5 text-tx-tertiary group-hover:text-indigo-400 transition-colors" />
        )}
      </button>

      {/* Title + 元信息：用列布局承载多行
          - 外层 `flex-1 min-w-0`：把宽度让给主标题区域，仍让右侧徽标区不被挤压；
          - 内部用 flex-col：标题在上、元信息（移动端 DateBadge + creator）在下。
            创建者徽标用更弱的色阶（tx-tertiary）+ 10px 字号，避免抢标题视线。

          v16 P3 fix（移动端 DateBadge 截断）：
            桌面端 Badges 横向排在右侧（DateBadge / Flag / Trash），但在移动端 ~360px
            视口 + 长 dueDate 文案（"已逾期 11/05" ≈ 110px）会让 Badges 区超出列表项右沿
            被裁切——表现为 "已逾期" 半截、日期不可见。
            修复：移动端 DateBadge 下沉到标题下方（与 creator 同列、用 `flex-wrap` 容纳），
            右侧 Badges 区只剩 Flag + Trash 两个固定 14px 图标，给标题让出更多横向空间。
            桌面端保持原版式不变（md: 下隐藏下沉 DateBadge，Badges 区显示 DateBadge）。 */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span
          className={cn(
            // v16 P3 fix（移动端长标题/带链接标题溢出截断）：
            //   - 移动端字号 13px（text-[13px]），桌面端保持 14px（md:text-sm）——
            //     一行能多容纳 1-2 个中文字符，配合下方 break-words 缓解中英混排截断。
            //   - `break-words`(=word-break:break-word) + `[overflow-wrap:anywhere]`：
            //     原 `break-all` 对长 URL/中文有效，但**对内嵌的 inline-flex 链接胶囊
            //     无能为力**（atomic 元素不能在字符级断行）。`overflow-wrap:anywhere`
            //     允许在任意位置（包括链接胶囊前后）软换行，杜绝胶囊把行宽撑到父容器外。
            //   - `line-clamp-2` 保留省略号截断：超过 2 行的标题尾部 ... 收起。
            "text-[13px] md:text-sm leading-relaxed break-words [overflow-wrap:anywhere] line-clamp-2 transition-all",
            isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
          )}
          title={task.title}
        >
          <TitleView title={task.title} compact isCompleted={isCompleted} />
        </span>
        {/* 移动端元信息行：DateBadge + creator，flex-wrap 防止两者并排时溢出。
            注意 md:hidden——桌面端 DateBadge 仍在右侧 Badges 里，避免重复。 */}
        {(task.dueDate || showCreator) && (
          <div className="md:hidden flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
            <DateBadge dateStr={task.dueDate} />
            {showCreator && (
              <span
                className="flex items-center gap-1 text-[10px] text-tx-tertiary min-w-0"
                title={t('common.createdBy', { name: task.creatorName })}
              >
                <UserIcon size={10} className="shrink-0" />
                <span className="truncate">{task.creatorName}</span>
              </span>
            )}
          </div>
        )}
        {/* 桌面端 creator 行：移动端已在上面元信息行渲染，这里仅桌面端显示 */}
        {showCreator && (
          <span
            className="hidden md:flex items-center gap-1 text-[10px] text-tx-tertiary truncate"
            title={t('common.createdBy', { name: task.creatorName })}
          >
            <UserIcon size={10} className="shrink-0" />
            <span className="truncate">{task.creatorName}</span>
          </span>
        )}
        {/* 标签 */}
        {task.tags && task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {task.tags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border"
                style={{
                  backgroundColor: tag.color + "10",
                  borderColor: tag.color + "25",
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Badges —— items-start 之后要用 mt-0.5 对齐到首行
          移动端：仅 Flag + Trash（DateBadge 已下沉到标题下方）
          桌面端：DateBadge + Flag + Trash 三个横向排列 */}
      <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
        <span className="hidden md:inline-flex">
          <DateBadge dateStr={task.dueDate} />
        </span>
        <Flag size={14} className={pri.flagClass} />
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  );
});

/* ===== 任务详情面板 ===== */
const TaskDetail = React.forwardRef<HTMLDivElement, {
  task: Task;
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Task> & { tagIds?: string[] }) => void;
  onDelete: (id: string) => void;
}>(({ task, onClose, onUpdate, onDelete }, ref) => {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "zh-CN" ? zhCN : enUS;
  // 详情里 title 编辑：把图片/链接 token 折叠掉只保留 plain 文本，
  // 否则用户在 input 里看到一坨 markdown 源码很丑且容易误删 url。
  // 用户编辑的纯文本会被回写到 title 的"非 token 部分"——但这需要一致的
  // 重组算法，超出当前迭代范围；这里采用"完整 markdown 源码可见且可编辑"的
  // textarea，保证可逆，富文本预览紧贴下方。
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || "");
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // @提及选择器状态
  const [cursorPos, setCursorPos] = useState(0);
  const mentionTrigger = useMentionState(title, cursorPos);

  const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
    3: { label: t('tasks.high'), color: "text-red-500", flagClass: "text-red-500" },
    2: { label: t('tasks.medium'), color: "text-amber-500", flagClass: "text-amber-500" },
    1: { label: t('tasks.low'), color: "text-blue-400", flagClass: "text-blue-400" },
  };

  const [remindAt, setRemindAt] = useState(task.remindAt || "");
  const [taskTags, setTaskTags] = useState<Tag[]>(task.tags || []);

  useEffect(() => {
    setTitle(task.title);
    setPriority(task.priority);
    setDueDate(task.dueDate || "");
    setRemindAt(task.remindAt || "");
    setTaskTags(task.tags || []);
  }, [task.id]);

  const handleSave = () => {
    onUpdate(task.id, {
      title: title.trim() || task.title,
      priority,
      dueDate: dueDate || null,
      remindAt: remindAt || null,
      tagIds: taskTags.map((t) => t.id),
    });
  };

  const handleTagsChange = (newTags: Tag[]) => {
    setTaskTags(newTags);
    onUpdate(task.id, { tagIds: newTags.map((t) => t.id) });
  };

  const hasRichTokens = parseTaskTitle(task.title).some((tok) => tok.kind !== "text");

  return (
    <motion.div
      ref={ref}
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className={cn(
        "h-full border-l border-app-border bg-app-surface flex flex-col shrink-0",
        // 移动端：全屏覆盖
        "fixed inset-0 z-30 w-full border-l-0",
        // 桌面端：侧边面板
        "md:static md:z-auto md:w-[340px] md:min-w-[340px] md:border-l"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border" style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)' }}>
        <span className="text-sm font-semibold text-tx-primary">{t('tasks.taskDetail')}</span>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover transition-colors">
          <X size={16} className="text-tx-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* 标题 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.taskTitle')}</label>
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setCursorPos(e.target.selectionStart);
            }}
            onKeyUp={(e: any) => {
              setCursorPos(e.target.selectionStart);
            }}
            onClick={(e: any) => {
              setCursorPos(e.target.selectionStart);
            }}
            onBlur={handleSave}
            rows={Math.min(4, Math.max(2, title.split("\n").length))}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors resize-y font-mono"
          />

          {/* @提及选择器 */}
          {mentionTrigger && (
            <div className="relative z-50">
              <MentionPicker
                search={mentionTrigger.search}
                onSelect={(user) => {
                  const newText = replaceMentionText(title, cursorPos, mentionTrigger.startIndex, user.username);
                  setTitle(newText);
                  setCursorPos(mentionTrigger.startIndex + user.username.length + 2);
                  mentionTrigger.clear();
                  onUpdate(task.id, { title: newText });
                  titleRef.current?.focus();
                }}
                onClose={mentionTrigger.clear}
              />
            </div>
          )}

          {/* 富文本预览：仅当含 token 时显示，避免占位 */}
          {hasRichTokens && (
            <div className="mt-2 px-3 py-2 rounded-md bg-app-elevated border border-app-border text-sm text-tx-primary leading-relaxed break-all">
              <TitleView title={title} compact={false} isCompleted={task.isCompleted === 1} />
            </div>
          )}
        </div>

        {/* 优先级 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.priority')}</label>
          <div className="flex gap-2">
            {([3, 2, 1] as TaskPriority[]).map((p) => {
              const cfg = PRIORITY_CONFIG[p];
              return (
                <button
                  key={p}
                  onClick={() => { setPriority(p); onUpdate(task.id, { priority: p }); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-all",
                    priority === p
                      ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                      : "border-app-border text-tx-secondary hover:bg-app-hover"
                  )}
                >
                  <Flag size={12} className={priority === p ? cfg.flagClass : ""} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 截止日期 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.dueDate')}</label>
          <input
            type="date"
            value={dueDate ? dueDate.split("T")[0] : ""}
            onChange={(e) => {
              const val = e.target.value || null;
              setDueDate(val || "");
              let nextRemindAt = remindAt;
              if (val && !remindAt) {
                const date = new Date(val);
                date.setDate(date.getDate() - 1);
                nextRemindAt = date.toISOString().split("T")[0];
                setRemindAt(nextRemindAt);
              }
              onUpdate(task.id, { dueDate: val, remindAt: nextRemindAt || null });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* 提醒开始日期 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.remindAt', '提醒日期')}</label>
          <input
            type="date"
            value={remindAt ? remindAt.split("T")[0] : ""}
            onChange={(e) => {
              const val = e.target.value || null;
              setRemindAt(val || "");
              onUpdate(task.id, { remindAt: val });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* 标签 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.tags', '任务标签')}</label>
          <GenericTagInput
            selectedTags={taskTags}
            onTagsChange={handleTagsChange}
            placeholder={t('tags.addTagPlaceholder')}
          />
        </div>

        {/* 创建时间 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">{t('tasks.createdAt')}</label>
          <span className="text-sm text-tx-secondary">
            {format(parseISO(task.createdAt + (task.createdAt.endsWith("Z") ? "" : "Z")), "yyyy-MM-dd HH:mm", { locale: dateLocale })}
          </span>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-app-border" style={{ paddingBottom: 'calc(var(--safe-area-bottom) + 16px)' }}>
        <button
          onClick={() => { onDelete(task.id); onClose(); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-accent-danger border border-accent-danger/30 hover:bg-accent-danger/10 transition-colors"
        >
          <Trash2 size={14} />
          {t('tasks.deleteTask')}
        </button>
      </div>
    </motion.div>
  );
});

/* ===========================================================================
 * 新建任务输入区组件
 * ---------------------------------------------------------------------------
 * - 单行 <input> + 上传按钮 + 已上传图片缩略图条
 * - 粘贴：
 *     * clipboard 中含 image/* —— 自动调用 task-attachments.upload，把
 *       返回的 url 拼成 `![filename](url)` 追加到 title。
 *     * clipboard 中是 http(s) URL 文本 —— 自动包成 `[hostname](url)`
 *       插入到光标处，让标题保持紧凑。
 * - 上传按钮：触发隐藏的 <input type=file>，多选支持。
 * ========================================================================= */
function QuickAdd({
  value,
  onChange,
  onSubmit,
  onUploaded,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onUploaded: (orphanIds: string[]) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // 拖拽态：把整条输入框做成 dropzone，与 onPaste 粘贴图片体验对齐。
  // 用 counter 处理 enter/leave 的子节点冒泡（缩略图、按钮等）抖动问题。
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // 已上传但还未与任务绑定的"孤儿附件 id" —— 用于：
  //   1) 在输入框旁渲染缩略图供用户预览/移除；
  //   2) 提交任务后调用 bind 把它们绑回新创建的 task。
  const [orphans, setOrphans] = useState<{ id: string; url: string; filename: string }[]>([]);

  // @提及选择器状态
  const [cursorPos, setCursorPos] = useState(0);
  const mentionTrigger = useMentionState(value, cursorPos);

  // 把附件 markdown 插入到 input 当前光标处；如果焦点不在 input，就追加到末尾。
  const insertAtCaret = (snippet: string) => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      onChange((value ? value + " " : "") + snippet);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    // 光标移到插入片段之后
    requestAnimationFrame(() => {
      const pos = start + snippet.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        if (!f.type.startsWith("image/")) {
          toast.error(t('tasks.imageInvalidType'));
          continue;
        }
        if (f.size > 50 * 1024 * 1024) {
          toast.error(t('tasks.imageTooLarge'));
          continue;
        }
        try {
          const res = await api.taskAttachments.upload(f);
          insertAtCaret(`![${res.filename}](${res.url})`);
          setOrphans((prev) => [...prev, { id: res.id, url: res.url, filename: res.filename }]);
        } catch (e: any) {
          toast.error(e?.message || t('tasks.uploadFailed'));
        }
      }
    } finally {
      setUploading(false);
    }
  }, [t, value]);

  // 提交：交还给父组件创建任务；父组件创建成功后会把 orphans 列表 bind 回去
  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit();
    // 把孤儿列表交给父组件处理 bind，本地清掉
    onUploaded(orphans.map((o) => o.id));
    setOrphans([]);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    // 1) 优先处理图片
    const imgFiles: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imgFiles.push(f);
      }
    }
    if (imgFiles.length) {
      e.preventDefault();
      await uploadFiles(imgFiles);
      return;
    }
    // 2) 没有图片时检查纯文本是否是 URL —— 是就转成 markdown 链接，
    //    避免长 URL 撑破列表。
    const text = e.clipboardData.getData("text/plain");
    if (text && isHttpUrl(text)) {
      e.preventDefault();
      insertAtCaret(`[${hostnameOf(text.trim())}](${text.trim()})`);
    }
  };

  const removeOrphan = async (id: string) => {
    // 同步删后端文件 + 行；同时把 title 里的对应 markdown 移除。
    try {
      await api.taskAttachments.remove(id);
    } catch {
      /* 删失败不阻塞 UI；后台清理脚本会兜底 */
    }
    setOrphans((prev) => prev.filter((o) => o.id !== id));
    // 移除 title 里 ![...](url-with-id)
    const re = new RegExp(`!\\[[^\\]]*\\]\\(/api/task-attachments/${id}\\)\\s?`, "g");
    onChange(value.replace(re, ""));
  };

  return (
    <div
      className={cn(
        "px-4 py-2.5 rounded-lg border border-dashed bg-app-elevated/50 transition-colors",
        dragOver
          ? "border-accent-primary bg-accent-primary/5 ring-2 ring-accent-primary/30"
          : "border-app-border hover:border-accent-primary/40",
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        // accept="image/*" 与 input 对齐：拖入非图片直接忽略
        const files = Array.from(e.dataTransfer.files || []).filter(
          (f) => f.type.startsWith("image/"),
        );
        if (files.length > 0) void uploadFiles(files);
      }}
    >
      <div className="flex items-center gap-3">
        <Plus size={16} className="text-tx-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCursorPos(e.target.selectionStart || 0);
          }}
          onKeyUp={(e: any) => {
            setCursorPos(e.target.selectionStart || 0);
          }}
          onClick={(e: any) => {
            setCursorPos(e.target.selectionStart || 0);
          }}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          onPaste={handlePaste}
          placeholder={t('tasks.addTaskPlaceholder')}
          className="flex-1 min-w-0 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t('tasks.insertImage')}
          className="flex-shrink-0 p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
        >
          {uploading
            ? <Loader2 size={16} className="animate-spin" />
            : <ImagePlus size={16} />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            uploadFiles(files);
            e.target.value = ""; // 允许重复选同一个文件
          }}
        />
      </div>

      {/* @提及选择器 */}
      {mentionTrigger && (
        <div className="relative z-50">
          <MentionPicker
            search={mentionTrigger.search}
            onSelect={(user) => {
              const newText = replaceMentionText(value, cursorPos, mentionTrigger.startIndex, user.username);
              onChange(newText);
              setCursorPos(mentionTrigger.startIndex + user.username.length + 2);
              mentionTrigger.clear();
              inputRef.current?.focus();
            }}
            onClose={mentionTrigger.clear}
          />
        </div>
      )}

      {/* 已上传图片缩略图条 —— 仅在有孤儿时渲染，不占位 */}
      {orphans.length > 0 && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {orphans.map((o) => (
            <div key={o.id} className="relative group">
              <img
                src={o.url}
                alt={o.filename}
                className="w-12 h-12 rounded object-cover border border-app-border"
              />
              <button
                type="button"
                onClick={() => removeOrphan(o.id)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-app-bg border border-app-border text-tx-secondary hover:text-accent-danger hover:border-accent-danger flex items-center justify-center transition-colors"
                title={t('common.delete') || 'Remove'}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== 主组件 ===== */
export default function TaskCenter() {
  const { t } = useTranslation();

  const FILTERS: { key: TaskFilter; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: t('tasks.allTasks'), icon: <Inbox size={16} /> },
    { key: "today", label: t('tasks.today'), icon: <CalendarDays size={16} /> },
    { key: "week", label: t('tasks.next7Days'), icon: <Calendar size={16} /> },
    { key: "overdue", label: t('tasks.overdue'), icon: <AlertTriangle size={16} /> },
    { key: "completed", label: t('tasks.completed'), icon: <CheckCheck size={16} /> },
  ];

  const { state } = useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  // pendingOrphans 由 QuickAdd 在提交瞬间回传，主组件在 createTask 成功后
  // 把这些孤儿附件 bind 到新 task；提交失败时孤儿留在表里由清理脚本处理。
  const pendingOrphansRef = useRef<string[]>([]);

  const loadTasks = useCallback(async () => {
    try {
      const [data, statsData] = await Promise.all([
        api.getTasks(filter, undefined, searchQuery || undefined, selectedTagId || undefined),
        api.getTaskStats(),
      ]);
      setTasks(data);
      setStats(statsData);
      
      syncAllTaskNotifications(data);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [filter, searchQuery, selectedTagId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // 工作区切换：关闭详情面板并重新拉当前筛选下的任务列表
  useEffect(() => {
    const onWs = () => {
      setSelectedTask(null);
      loadTasks();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadTasks]);

  const handleToggle = async (id: string) => {
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isCompleted: t.isCompleted ? 0 : 1 } : t))
    );
    try {
      const updated = await api.toggleTask(id);
      
      syncTaskNotification(updated);
      window.dispatchEvent(new CustomEvent("nowen:task-stats-changed"));

      // Refresh stats
      const s = await api.getTaskStats();
      setStats(s);
    } catch {
      loadTasks(); // rollback
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    const titleToCreate = newTitle.trim();
    const orphanIds = pendingOrphansRef.current;
    pendingOrphansRef.current = [];
    try {
      const task = await api.createTask({ title: titleToCreate });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      // 把孤儿附件 bind 到新 task（CASCADE 关系建立后，删任务会自动清附件）
      if (orphanIds.length) {
        await Promise.all(
          orphanIds.map((id) =>
            api.taskAttachments.bind(id, task.id).catch(() => null)
          )
        );
      }
      
      syncTaskNotification(task);
      window.dispatchEvent(new CustomEvent("nowen:task-stats-changed"));

      const s = await api.getTaskStats();
      setStats(s);
    } catch (err) {
      console.error("Failed to create task:", err);
      // 创建失败时把孤儿放回去，下次提交还能用
      pendingOrphansRef.current = orphanIds;
    }
  };

  const handleUpdate = async (id: string, data: Partial<Task> & { tagIds?: string[] }) => {
    try {
      const updated = await api.updateTask(id, data);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      if (selectedTask?.id === id) setSelectedTask(updated);
      
      syncTaskNotification(updated);
      window.dispatchEvent(new CustomEvent("nowen:task-stats-changed"));

      // 关键字段（dueDate / priority / isCompleted 等）变化会影响左侧
      // 「今天 / 未来 7 天 / 已逾期 / 已完成」分组计数，需要同步刷新统计。
      // 用 affectsStats 判断，避免改个标题/备注也发一次 stats 请求。
      const affectsStats =
        "dueDate" in data ||
        "isCompleted" in data ||
        "priority" in data ||
        "remindAt" in data;
      if (affectsStats) {
        try {
          const s = await api.getTaskStats();
          setStats(s);
        } catch (e) {
          console.error("Failed to refresh task stats:", e);
        }
      }
    } catch (err) {
      console.error("Failed to update task:", err);
    }
  };

  const handleDelete = async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTask?.id === id) setSelectedTask(null);
    try {
      syncTaskNotification({ id, isCompleted: 1 } as any);
      await api.deleteTask(id);
      
      window.dispatchEvent(new CustomEvent("nowen:task-stats-changed"));

      const s = await api.getTaskStats();
      setStats(s);
    } catch {
      loadTasks();
    }
  };

  const filterCount = (key: TaskFilter): number => {
    if (!stats) return 0;
    switch (key) {
      case "all": return stats.total;
      case "today": return stats.today;
      case "week": return stats.week ?? 0;
      case "overdue": return stats.overdue;
      case "completed": return stats.completed;
      default: return 0;
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden relative">
      {/* Left: Filter Panel — 桌面端显示 */}
      <div className="hidden md:flex w-[220px] min-w-[220px] shrink-0 border-r border-app-border bg-app-surface flex-col transition-colors">
        <div className="px-4 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <ListTodo size={18} className="text-accent-primary" />
            <h2 className="text-sm font-bold text-tx-primary">{t('tasks.title')}</h2>
          </div>
          {stats && (
            <div className="mt-2 text-xs text-tx-tertiary">
              {t('tasks.pendingCount', { pending: stats.pending, completed: stats.completed })}
            </div>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTagId(null); setSelectedTask(null); }}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
                filter === f.key && !selectedTagId
                  ? "bg-app-active text-accent-primary"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              )}
            >
              <span className="flex items-center gap-2.5">
                {f.icon}
                {f.label}
              </span>
              <span className={cn(
                "text-xs min-w-[20px] text-center rounded-full px-1.5 py-0.5",
                filter === f.key && !selectedTagId ? "bg-accent-primary/20 text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}

          {state.tags.length > 0 && (
            <div className="mt-4 pt-4 border-t border-app-border/60">
              <div className="px-3 mb-1.5 text-xs font-semibold text-tx-tertiary uppercase tracking-wider">
                {t('tags.title', '标签')}
              </div>
              <div className="space-y-0.5">
                {state.tags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      setSelectedTagId(selectedTagId === tag.id ? null : tag.id);
                      setSelectedTask(null);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors text-left",
                      selectedTagId === tag.id
                        ? "bg-app-active text-accent-primary"
                        : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    )}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="flex-1 truncate">{tag.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </nav>
      </div>

      {/* Center: Task List */}
      <div className="flex-1 flex flex-col overflow-hidden bg-app-bg transition-colors">
        {/* 移动端：水平筛选标签 */}
        <div className="md:hidden flex items-center gap-1 px-3 py-2 border-b border-app-border overflow-x-auto no-scrollbar bg-app-surface/20">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTagId(null); setSelectedTask(null); }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                filter === f.key && !selectedTagId
                  ? "bg-accent-primary/15 text-accent-primary"
                  : "text-tx-secondary bg-app-hover/50 active:bg-app-active"
              )}
            >
              {f.icon}
              {f.label}
              <span className={cn(
                "text-[10px] min-w-[16px] text-center",
                filter === f.key && !selectedTagId ? "text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
        </div>

        {/* 移动端：水平标签筛选 */}
        {state.tags.length > 0 && (
          <div className="md:hidden flex items-center gap-1.5 px-3 py-1.5 border-b border-app-border overflow-x-auto no-scrollbar bg-app-surface/5">
            {state.tags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => {
                  setSelectedTagId(selectedTagId === tag.id ? null : tag.id);
                  setSelectedTask(null);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors shrink-0 border",
                  selectedTagId === tag.id
                    ? "bg-accent-primary/10 text-accent-primary border-accent-primary/30"
                    : "text-tx-secondary bg-transparent border-app-border hover:border-tx-tertiary"
                )}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            ))}
          </div>
        )}

        {/* Search & Header (Desktop & Mobile) */}
        <div className="px-4 md:px-6 py-3 border-b border-app-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-app-surface/10">
          <div className="flex items-center gap-3">
            <h1 className="text-base md:text-lg font-bold text-tx-primary whitespace-nowrap">
              {viewMode === "calendar" ? "日历视图" : (FILTERS.find((f) => f.key === filter)?.label || t('tasks.allTasks'))}
              {selectedTagId && viewMode === "list" && (
                <span className="text-xs font-normal text-tx-tertiary ml-2">
                  (#{state.tags.find(t => t.id === selectedTagId)?.name})
                </span>
              )}
            </h1>
            <button
              onClick={() => setViewMode((v) => (v === "list" ? "calendar" : "list"))}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center transition-all",
                viewMode === "calendar"
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:bg-app-hover",
              )}
              title={viewMode === "calendar" ? "列表视图" : "日历视图"}
            >
              {viewMode === "calendar" ? <ListTodo size={16} /> : <CalendarDays size={16} />}
            </button>
          </div>
          <div className="relative w-full sm:w-64 shrink-0">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('tasks.searchPlaceholder', '搜索任务...')}
              className="w-full px-3 py-1.5 text-xs rounded-md bg-app-bg border border-app-border text-tx-primary placeholder:text-tx-tertiary focus:outline-none focus:border-accent-primary focus:ring-1 focus:ring-accent-primary/20 transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-tx-tertiary hover:text-tx-primary"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {viewMode === "calendar" ? (
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
            <TaskCalendar onDateSelect={() => {
              setViewMode("list");
            }} />
          </div>
        ) : (
          <>
            {/* Quick Add */}
            <div className="px-4 md:px-6 py-3 border-b border-app-border">
              <QuickAdd
                value={newTitle}
                onChange={setNewTitle}
                onSubmit={handleCreate}
                onUploaded={(ids) => { pendingOrphansRef.current = ids; }}
                inputRef={inputRef}
              />
            </div>

            {/* Task List */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6 py-3">
              {isLoading ? (
                <div className="flex items-center justify-center h-32 text-tx-tertiary text-sm">
                  {t('common.loading')}
                </div>
              ) : tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-tx-tertiary">
                  <CheckCheck size={36} className="mb-3 opacity-40" />
                  <span className="text-sm">{t('tasks.noTasks')}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onToggle={handleToggle}
                        onSelect={setSelectedTask}
                        onDelete={handleDelete}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right: Detail Drawer */}
      <AnimatePresence>
        {selectedTask && (
          <TaskDetail
            key={selectedTask.id}
            task={selectedTask}
            onClose={() => setSelectedTask(null)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
