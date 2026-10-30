export const zhCNAssetToolsTranslations = {
  assetTools: {
    similar: "查找相似图片",
    similarHint:
      "按色彩和画面布局寻找近似图片，仅供人工核对。只检查当前空间内可下载的 PNG、JPEG、WebP、GIF（首帧）、BMP；单张最多 20 MiB、4000 万像素。不会自动合并或删除。",
    scanCount:
      "已检查 {{examined}} 张 · 跳过 {{skipped}} 张（过大、损坏或暂不可读）",
    scanning: "正在检查本批图片…",
    partial: "尚未扫描完当前空间",
    complete: "当前扫描已完成",
    scanMore: "继续检查下一批",
    noMatches: "已检查的图片中没有发现相似结果。",
    rename: "批量重命名",
    renameHint:
      "预览后统一保存：使用名称加编号，保留每个文件的原扩展名。文件 ID、原文件和笔记引用保持不变。某项无权限或名称已变化时，整批不修改。",
    baseName: "统一名称",
    start: "起始编号",
    before: "原名称",
    after: "新名称",
    confirmRename: "确认重命名 {{count}} 个文件",
    reloadPreview: "刷新预览",
    invalidName:
      "请输入有效名称和起始编号（1–999999），生成的文件名不能超过 255 个字符。",
    nativeUnavailable:
      "当前 Native 模式暂不支持相似图片搜索和批量重命名，请在网页端或桌面端文件中心操作。",
    fileUnavailable: "文件已不可用，请刷新后重试。",
    imageUnsupported: "请选择 20 MiB 以内的 PNG、JPEG、WebP、GIF 或 BMP 图片。",
    imageUnavailable: "图片暂时无法读取或解码，请检查原文件后重试。",
    searchBusy: "图片搜索正忙，请稍后重试。",
    scopeMismatch: "请在当前空间选择文件。",
    nameConflict: "有文件名称已变化，本批未修改。请刷新预览后重新确认。",
    cursorInvalid: "扫描位置已失效，请关闭后重新搜索。",
    forbidden: "你没有操作所选文件的权限，本批未修改。",
  },
};
export const enAssetToolsTranslations = {
  assetTools: {
    similar: "Find similar images",
    similarHint:
      "Find approximate matches by color and layout for manual review. Checks downloadable PNG, JPEG, WebP, GIF (first frame) and BMP images in the current space, up to 20 MiB and 40 megapixels each. Never merges or deletes files automatically.",
    scanCount:
      "Checked {{examined}} · Skipped {{skipped}} (too large, damaged or unavailable)",
    scanning: "Checking this batch…",
    partial: "More images remain in this space",
    complete: "Current scan complete",
    scanMore: "Check next batch",
    noMatches: "No similar images found among the checked files.",
    rename: "Batch rename",
    renameHint:
      "Review names before saving. Adds numbers to a common name and keeps original extensions, file IDs, bytes and note references. If any file is unavailable or its name changed, the entire batch stays unchanged.",
    baseName: "Common name",
    start: "Start number",
    before: "Current name",
    after: "New name",
    confirmRename: "Rename {{count}} files",
    reloadPreview: "Refresh preview",
    invalidName:
      "Enter a valid name and start number (1–999999). Generated names must fit within 255 characters.",
    nativeUnavailable:
      "Similar-image search and batch rename are unavailable in Native mode. Use the web or desktop file center.",
    fileUnavailable: "A file is no longer available. Refresh and try again.",
    imageUnsupported:
      "Choose a PNG, JPEG, WebP, GIF or BMP image up to 20 MiB.",
    imageUnavailable:
      "The image could not be read or decoded. Check the original and retry.",
    searchBusy: "Image search is busy. Please try again shortly.",
    scopeMismatch: "Choose files in the current space.",
    nameConflict:
      "A file name changed. This batch was not modified. Refresh the preview and confirm again.",
    cursorInvalid:
      "The scan position is invalid. Close and restart the search.",
    forbidden:
      "You cannot modify every selected file. This batch was not modified.",
  },
};
