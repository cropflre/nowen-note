from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "backend/src/routes/shares.ts",
    'import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";\n',
    'import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";\nimport { parseShareManagementQuery, queryShareManagement } from "../services/share-management";\n',
)

replace_once(
    "backend/src/routes/shares.ts",
    '''// 获取当前用户的所有分享
sharesRouter.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const shares = db.prepare(`
    SELECT s.*, n.title AS noteTitle
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.ownerId = ?
    ORDER BY s.createdAt DESC
  `).all(userId) as any[];

  // 移除密码 hash，添加 hasPassword 标记
  return c.json(shares.map((s: any) => {
    const hasPassword = !!s.password;
    delete s.password;
    return { ...s, hasPassword };
  }));
});''',
    '''// 获取当前用户的所有分享。management=1 启用分享管理中心的筛选、统计和分页响应；
// 未携带该参数时继续返回旧数组结构，避免破坏 SDK 与历史客户端。
sharesRouter.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (c.req.query("management") === "1") {
    return c.json(queryShareManagement(db, userId, parseShareManagementQuery(c.req.query())));
  }

  const shares = db.prepare(`
    SELECT s.*, n.title AS noteTitle
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.ownerId = ?
    ORDER BY s.createdAt DESC
  `).all(userId) as any[];

  return c.json(shares.map((s: any) => {
    const hasPassword = !!s.password;
    delete s.password;
    return { ...s, hasPassword };
  }));
});''',
)

replace_once(
    "backend/src/routes/shares.ts",
    '''  const shares = db.prepare(`
    SELECT * FROM shares WHERE noteId = ? AND ownerId = ? ORDER BY createdAt DESC
  `).all(noteId, userId) as any[];''',
    '''  const capabilities = resolveEffectiveNoteCapabilities(noteId, userId);
  const shares = capabilities.manage
    ? db.prepare("SELECT * FROM shares WHERE noteId = ? ORDER BY createdAt DESC").all(noteId)
    : db.prepare("SELECT * FROM shares WHERE noteId = ? AND ownerId = ? ORDER BY createdAt DESC").all(noteId, userId) as any[];''',
)

replace_once(
    "backend/src/routes/shares.ts",
    '''  const share = db.prepare("SELECT * FROM shares WHERE id = ? AND ownerId = ?").get(id, userId) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);''',
    '''  const share = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);
  const capabilities = resolveEffectiveNoteCapabilities(share.noteId, userId);
  if (share.ownerId !== userId && !capabilities.manage) {
    return c.json({ error: "分享不存在" }, 404);
  }''',
)

replace_once(
    "frontend/src/types/index.ts",
    'export type ViewMode = "notebook" | "favorites" | "trash" | "all" | "search" | "tasks" | "tag" | "mindmaps" | "ai-chat" | "diary" | "files";',
    'export type ViewMode = "notebook" | "favorites" | "trash" | "all" | "search" | "tasks" | "tag" | "mindmaps" | "ai-chat" | "diary" | "files" | "shares";',
)

replace_once(
    "frontend/src/types/index.ts",
    '''export interface Share {
  id: string;
  noteId: string;
  ownerId: string;
  shareToken: string;
  shareType: string;
  permission: SharePermission;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  noteTitle?: string;
}
''',
    '''export interface Share {
  id: string;
  noteId: string;
  ownerId: string;
  shareToken: string;
  shareType: string;
  permission: SharePermission;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  noteTitle?: string;
}

export type ShareEffectiveStatus = "active" | "disabled" | "expired" | "exhausted";

export interface ShareManagementItem extends Share {
  noteTitle: string | null;
  notebookId: string | null;
  notebookName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  noteIsTrashed: boolean;
  noteMissing: boolean;
  effectiveStatus: ShareEffectiveStatus;
}

export interface ShareManagementResponse {
  items: ShareManagementItem[];
  total: number;
  page: number;
  pageSize: number;
  stats: {
    total: number;
    active: number;
    disabled: number;
    expired: number;
    exhausted: number;
  };
}

export interface ShareManagementQuery {
  q?: string;
  status?: ShareEffectiveStatus;
  permission?: SharePermission;
  hasPassword?: boolean;
  sort?: "createdAt" | "updatedAt" | "expiresAt" | "noteTitle";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}
''',
)

replace_once(
    "frontend/src/lib/api.impl.ts",
    '''  getShares: () => request<Share[]>("/shares"),
  getSharesByNote: (noteId: string) => request<Share[]>(`/shares/note/${noteId}`),''',
    '''  getShares: () => request<Share[]>("/shares"),
  getShareManagement: (params: import("@/types").ShareManagementQuery = {}) => {
    const qs = new URLSearchParams({ management: "1" });
    if (params.q) qs.set("q", params.q);
    if (params.status) qs.set("status", params.status);
    if (params.permission) qs.set("permission", params.permission);
    if (params.hasPassword !== undefined) qs.set("hasPassword", params.hasPassword ? "1" : "0");
    if (params.sort) qs.set("sort", params.sort);
    if (params.order) qs.set("order", params.order);
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    return request<import("@/types").ShareManagementResponse>(`/shares?${qs.toString()}`);
  },
  getSharesByNote: (noteId: string) => request<Share[]>(`/shares/note/${noteId}`),''',
)

replace_once(
    "frontend/src/components/NavRail.tsx",
    '''  FolderOpen,
  ListTodo,
  LogOut,''',
    '''  FolderOpen,
  ListTodo,
  Link2,
  LogOut,''',
)

replace_once(
    "frontend/src/components/NavRail.tsx",
    '''  { icon: <Sparkles size={RAIL_ICON_SIZE} />, labelKey: "sidebar.aiChat", mode: "ai-chat", group: "tools" },
];''',
    '''  { icon: <Sparkles size={RAIL_ICON_SIZE} />, labelKey: "sidebar.aiChat", mode: "ai-chat", group: "tools" },
  { icon: <Link2 size={RAIL_ICON_SIZE} />, labelKey: "sidebar.shareManagement", mode: "shares", group: "tools" },
];''',
)

replace_once(
    "frontend/src/App.tsx",
    'import FileManager from "@/components/FileManager";\n',
    'import FileManager from "@/components/FileManager";\nimport ShareManagementPage from "@/components/ShareManagementPage";\n',
)

replace_once(
    "frontend/src/App.tsx",
    '''  const isDiaryView = state.viewMode === "diary";
  const isFilesView = state.viewMode === "files";
  const isRegularNoteBrowser = state.viewMode === "all" || state.viewMode === "notebook";''',
    '''  const isDiaryView = state.viewMode === "diary";
  const isFilesView = state.viewMode === "files";
  const isSharesView = state.viewMode === "shares";
  const isRegularNoteBrowser = state.viewMode === "all" || state.viewMode === "notebook";''',
)

replace_once(
    "frontend/src/App.tsx",
    '''      ) : isFilesView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <FileManager />
        </div>
      ) : (
        <div className="flex-1 flex relative overflow-hidden">''',
    '''      ) : isFilesView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <FileManager />
        </div>
      ) : isSharesView ? (
        <div className="flex-1 flex min-w-0 flex-col">
          <MobileTopBar />
          <ShareManagementPage />
        </div>
      ) : (
        <div className="flex-1 flex relative overflow-hidden">''',
)

replace_once(
    "frontend/src/components/ShareModal.tsx",
    '''interface ShareModalProps {
  noteId: string;
  noteTitle: string;
  onClose: () => void;
}''',
    '''interface ShareModalProps {
  noteId: string;
  noteTitle: string;
  initialShareId?: string;
  onClose: () => void;
}''',
)

replace_once(
    "frontend/src/components/ShareModal.tsx",
    '''export default function ShareModal({ noteId, noteTitle, onClose }: ShareModalProps) {''',
    '''export default function ShareModal({ noteId, noteTitle, initialShareId, onClose }: ShareModalProps) {''',
)

replace_once(
    "frontend/src/components/ShareModal.tsx",
    '''  const [originSaving, setOriginSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);''',
    '''  const [originSaving, setOriginSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const initialShareAppliedRef = useRef<string | null>(null);''',
)

replace_once(
    "frontend/src/components/ShareModal.tsx",
    '''  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      setShares(await api.getSharesByNote(noteId));
    } catch (error: any) {
      toast.error(error?.message || "加载分享列表失败");
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => { void loadShares(); }, [loadShares]);''',
    '''  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const nextShares = await api.getSharesByNote(noteId);
      setShares(nextShares);
      if (initialShareId && initialShareAppliedRef.current !== initialShareId) {
        const target = nextShares.find((share) => share.id === initialShareId);
        if (target) {
          initialShareAppliedRef.current = initialShareId;
          setEditingId(target.id);
          setPermission(target.permission);
          setPassword("");
          setExpiresAt(toLocalDateTime(target.expiresAt));
          setMaxViews(target.maxViews ? String(target.maxViews) : "");
        }
      }
    } catch (error: any) {
      toast.error(error?.message || "加载分享列表失败");
    } finally {
      setLoading(false);
    }
  }, [initialShareId, noteId]);

  useEffect(() => { initialShareAppliedRef.current = null; }, [initialShareId, noteId]);
  useEffect(() => { void loadShares(); }, [loadShares]);''',
)

replace_once(
    "frontend/src/i18n/locales/zh-CN.json",
    '    "fileManager": "文件管理",\n    "favorites": "收藏",',
    '    "fileManager": "文件管理",\n    "shareManagement": "分享管理",\n    "favorites": "收藏",',
)

replace_once(
    "frontend/src/i18n/locales/en.json",
    '    "fileManager": "Files",\n    "favorites": "Favorites",',
    '    "fileManager": "Files",\n    "shareManagement": "Share management",\n    "favorites": "Favorites",',
)

print("Issue #447 existing-file integration applied")
