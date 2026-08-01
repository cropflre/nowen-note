from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8-sig")
    if new in content:
        return
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, got {count}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "frontend/src/App.tsx",
    'import FolderSyncScheduler from "@/components/FolderSyncScheduler";\n',
    'import FolderSyncScheduler from "@/components/FolderSyncScheduler";\n'
    'import NoteWorkspaceLayoutController from "@/components/NoteWorkspaceLayoutController";\n',
)

replace_once(
    "frontend/src/App.tsx",
    '''      {/* 桌面端文件夹自动同步调度器（仅 Electron，无 UI） */}
      <FolderSyncScheduler />''',
    '''      {/* 桌面宽屏笔记布局：标准 / 三栏 / 专注，移动端保持逐级导航。 */}
      <NoteWorkspaceLayoutController />

      {/* 桌面端文件夹自动同步调度器（仅 Electron，无 UI） */}
      <FolderSyncScheduler />''',
)

folder_sync = ROOT / "frontend/src/components/FolderSyncScheduler.tsx"
content = folder_sync.read_text(encoding="utf-8-sig")
content = content.replace(
    'import NoteWorkspaceLayoutController from "@/components/NoteWorkspaceLayoutController";\n',
    "",
)
content = content.replace(
    ''' *
 * 此组件本身已经作为桌面/网页应用的全局后台控制器挂载，因此同时承载
 * NoteWorkspaceLayoutController。布局控制器只管理本地 UI 状态，不会触碰
 * 文件夹同步、笔记保存或服务端数据。
''',
    "",
)
content = content.replace(
    "  return <NoteWorkspaceLayoutController />;\n",
    "  return null;\n",
)
folder_sync.write_text(content, encoding="utf-8")

print("Mounted NoteWorkspaceLayoutController in AppLayout")
