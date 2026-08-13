"use strict";

function hasSelection(params) {
  return typeof params?.selectionText === "string" && params.selectionText.length > 0;
}

/**
 * 构建桌面端文本编辑菜单。所有编辑动作都使用 Electron role，确保粘贴继续进入
 * Chromium 原生 paste 事件链，不绕过编辑器的附件处理、清洗、选区和撤销历史。
 */
function buildTextContextMenuTemplate(params = {}) {
  const isEditable = params.isEditable === true;
  const selectionAvailable = hasSelection(params);
  const isMediaTarget = params.mediaType && params.mediaType !== "none";
  if (isMediaTarget || (!isEditable && !selectionAvailable)) return null;

  const editFlags = params.editFlags || {};
  const copyItem = {
    role: "copy",
    enabled: selectionAvailable && editFlags.canCopy === true,
  };
  const selectAllItem = {
    role: "selectAll",
    enabled: editFlags.canSelectAll === true,
  };

  if (!isEditable) {
    return [copyItem, { type: "separator" }, selectAllItem];
  }

  return [
    { role: "undo", enabled: editFlags.canUndo === true },
    { role: "redo", enabled: editFlags.canRedo === true },
    { type: "separator" },
    {
      role: "cut",
      enabled: selectionAvailable && editFlags.canCut === true,
    },
    copyItem,
    { role: "paste", enabled: editFlags.canPaste === true },
    { type: "separator" },
    selectAllItem,
  ];
}

function registerTextContextMenu(browserWindow, Menu) {
  if (!browserWindow?.webContents || typeof Menu?.buildFromTemplate !== "function") return;

  browserWindow.webContents.on("context-menu", (event, params) => {
    const template = buildTextContextMenuTemplate(params);
    if (!template) return;

    event.preventDefault();
    Menu.buildFromTemplate(template).popup({ window: browserWindow });
  });
}

module.exports = {
  buildTextContextMenuTemplate,
  registerTextContextMenu,
};
