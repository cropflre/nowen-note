import { useLayoutEffect, useMemo, useState } from "react";
import EditorPane from "@/components/EditorPane";
import { useApp } from "@/store/AppContext";
import { EDITOR_MODE_KEY, type EditorMode } from "@/lib/editorMode";

/**
 * 主编辑区需要根据笔记自身的 contentFormat 选择默认编辑器。
 *
 * EditorPane 内部仍保留 MD ↔ RTE 的手动切换协议，但它的初始模式来自全局
 * localStorage。桌面端双击 .md 文件时，后端创建的笔记已经是 markdown，若上一
 * 次全局模式为 tiptap，主编辑区仍会错误地用富文本打开。
 *
 * 这里在挂载 EditorPane 之前暂存该笔记应使用的模式，并用 noteId + mode 作为 key：
 * - markdown 笔记默认进入 MarkdownEditor；
 * - 其他笔记默认进入 TiptapEditor；
 * - 切换笔记时重新初始化，避免上一篇笔记的模式泄漏到下一篇；
 * - URL `?md=1|0` 仍由 resolveEditorMode 保持最高优先级，便于内部调试。
 *
 * 注意：不能调用 persistEditorMode()。该函数会广播账号偏好变更，把“当前笔记的
 * 格式”错误同步成用户的全局默认编辑器。这里只写兼容读取键，不发送偏好事件。
 */
export default function FormatAwareEditorPane() {
  const { state } = useApp();
  const note = state.activeNote;
  const mode: EditorMode = note?.contentFormat === "markdown" ? "md" : "tiptap";
  const editorKey = useMemo(
    () => note ? `${note.id}:${mode}` : "empty",
    [note?.id, mode],
  );
  const [preparedKey, setPreparedKey] = useState<string>(() => note ? "" : "empty");

  useLayoutEffect(() => {
    if (!note) {
      setPreparedKey("empty");
      return;
    }

    try {
      localStorage.setItem(EDITOR_MODE_KEY, mode);
    } catch {
      // 隐私模式或受限 WebView 中 localStorage 可能不可用；保持原模式兜底。
    }
    setPreparedKey(editorKey);
  }, [editorKey, mode, note?.id]);

  // useLayoutEffect 会在浏览器绘制前完成准备，避免先闪一下错误编辑器。
  if (note && preparedKey !== editorKey) {
    return <div className="flex-1 min-h-0 bg-app-bg" aria-hidden="true" />;
  }

  return <EditorPane key={editorKey} />;
}
