const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildTextContextMenuTemplate,
  registerTextContextMenu,
} = require("../text-context-menu");

function contextParams(overrides = {}) {
  return {
    isEditable: true,
    selectionText: "selected text",
    mediaType: "none",
    formControlType: "text-area",
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
    },
    ...overrides,
  };
}

function menuRoles(template) {
  return template.map((item) => item.type === "separator" ? "separator" : item.role);
}

test("editable text uses native editing roles and Chromium edit flags", () => {
  const template = buildTextContextMenuTemplate(contextParams({
    selectionText: "",
    editFlags: {
      canUndo: false,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canDelete: true,
      canSelectAll: true,
    },
  }));

  assert.deepEqual(menuRoles(template), [
    "undo",
    "redo",
    "separator",
    "cut",
    "copy",
    "paste",
    "separator",
    "selectAll",
  ]);
  assert.equal(template.find((item) => item.role === "undo").enabled, false);
  assert.equal(template.find((item) => item.role === "redo").enabled, true);
  assert.equal(template.find((item) => item.role === "cut").enabled, false);
  assert.equal(template.find((item) => item.role === "copy").enabled, false);
  assert.equal(template.find((item) => item.role === "paste").enabled, false);
  assert.equal(template.find((item) => item.role === "paste").click, undefined);
});

test("read-only selected text only exposes copy and select all", () => {
  const template = buildTextContextMenuTemplate(contextParams({
    isEditable: false,
    selectionText: "read-only selection",
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canDelete: false,
      canSelectAll: true,
    },
  }));

  assert.deepEqual(menuRoles(template), ["copy", "separator", "selectAll"]);
  assert.equal(template[0].enabled, true);
  assert.equal(template[2].enabled, true);
});

test("password fields never enable cut or copy without exposed selection text", () => {
  const template = buildTextContextMenuTemplate(contextParams({
    selectionText: "",
    formControlType: "input-password",
  }));

  assert.equal(template.find((item) => item.role === "cut").enabled, false);
  assert.equal(template.find((item) => item.role === "copy").enabled, false);
  assert.equal(template.find((item) => item.role === "paste").enabled, true);
});

test("non-text and media targets keep their existing context menu behavior", () => {
  assert.equal(buildTextContextMenuTemplate(contextParams({
    isEditable: false,
    selectionText: "",
  })), null);
  assert.equal(buildTextContextMenuTemplate(contextParams({
    mediaType: "image",
  })), null);
});

test("registers one webContents context-menu handler and opens it for the owner window", () => {
  let listener = null;
  let popupOptions = null;
  let prevented = false;
  const browserWindow = {
    webContents: {
      on(eventName, handler) {
        assert.equal(eventName, "context-menu");
        listener = handler;
      },
    },
  };
  const Menu = {
    buildFromTemplate(template) {
      assert.equal(template.find((item) => item.role === "cut").enabled, true);
      assert.equal(template.find((item) => item.role === "copy").enabled, true);
      assert.equal(template.find((item) => item.role === "paste").enabled, true);
      return {
        popup(options) {
          popupOptions = options;
        },
      };
    },
  };

  registerTextContextMenu(browserWindow, Menu);
  listener({ preventDefault: () => { prevented = true; } }, contextParams());

  assert.equal(prevented, true);
  assert.deepEqual(popupOptions, { window: browserWindow });
});

test("media targets do not prevent or replace existing context menus", () => {
  let listener = null;
  let buildCalls = 0;
  let prevented = false;
  const browserWindow = {
    webContents: {
      on(_eventName, handler) {
        listener = handler;
      },
    },
  };
  const Menu = {
    buildFromTemplate() {
      buildCalls += 1;
      return { popup() {} };
    },
  };

  registerTextContextMenu(browserWindow, Menu);
  listener(
    { preventDefault: () => { prevented = true; } },
    contextParams({ mediaType: "video" }),
  );

  assert.equal(prevented, false);
  assert.equal(buildCalls, 0);
});

test("main window installs the shared native text context menu", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(source, /require\("\.\/text-context-menu"\)/);
  assert.match(source, /registerTextContextMenu\(mainWindow, Menu\)/);
});
