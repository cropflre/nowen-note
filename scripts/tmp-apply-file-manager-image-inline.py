from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one target in {path}, found {count}: {old[:120]!r}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    'import { uploadAndInsertImage } from "@/lib/imageUploadService";\n',
    'import { uploadAndInsertImage } from "@/lib/imageUploadService";\n'
    'import { isInlineImageAttachment } from "@/lib/existingAttachmentInsert";\n',
)

replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''  const insertExistingAttachment = useCallback((item: FileItem) => {
    const anchor = attachmentLibraryAnchorRef.current;
    if (!editor || !restoreEditorInsertAnchor(anchor)) {
      closeAttachmentLibrary();
      toast.error(t("tiptap.attachmentInsertPositionLost", { defaultValue: "插入位置已失效，请重试" }));
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent(buildAttachmentLinkHtml(item.filename, item.url, item.size))
      .run();
    closeAttachmentLibrary();
    toast.success(t("tiptap.attachmentLinkInserted", { defaultValue: "附件链接已插入" }));
  }, [closeAttachmentLibrary, editor, restoreEditorInsertAnchor, t]);
''',
    '''  const insertExistingAttachment = useCallback((item: FileItem) => {
    const anchor = attachmentLibraryAnchorRef.current;
    if (!editor || !restoreEditorInsertAnchor(anchor)) {
      closeAttachmentLibrary();
      toast.error(t("tiptap.attachmentInsertPositionLost", { defaultValue: "插入位置已失效，请重试" }));
      return;
    }

    const inlineImage = isInlineImageAttachment(item);
    const chain = editor.chain().focus();
    if (inlineImage) {
      chain.setImage({
        src: item.url,
        alt: item.filename,
        title: item.filename,
      }).run();
    } else {
      chain
        .insertContent(buildAttachmentLinkHtml(item.filename, item.url, item.size))
        .run();
    }

    closeAttachmentLibrary();
    toast.success(inlineImage
      ? t("tiptap.imageInsertedFromFileManager", { defaultValue: "图片已插入" })
      : t("tiptap.attachmentLinkInserted", { defaultValue: "附件链接已插入" }));
  }, [closeAttachmentLibrary, editor, restoreEditorInsertAnchor, t]);
''',
)

replace_once(
    "frontend/src/components/MarkdownEditorImpl.tsx",
    'import { uploadAndInsertImage } from "@/lib/imageUploadService";\n',
    'import { uploadAndInsertImage } from "@/lib/imageUploadService";\n'
    'import { buildExistingAttachmentMarkdownSnippet } from "@/lib/existingAttachmentInsert";\n',
)

replace_once(
    "frontend/src/components/MarkdownEditorImpl.tsx",
    '''function buildMarkdownAttachmentSnippet(item: FileItem): string {
  const label = (item.filename || "attachment")
    .replace(/\\\\/g, "\\\\\\\\")
    .replace(/\\]/g, "\\\\]");
  const sizeLabel = formatBytesMd(item.size);
  return `[📎 ${label}${sizeLabel ? ` (${sizeLabel})` : ""}](${encodeMarkdownUrl(item.url)})`;
}
''',
    '''function buildMarkdownAttachmentSnippet(item: FileItem): string {
  return buildExistingAttachmentMarkdownSnippet(item);
}
''',
)
