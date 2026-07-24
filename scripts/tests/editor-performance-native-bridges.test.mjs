import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("Electron 性能采集桥只允许受信 renderer，并返回当前 renderer 内存", () => {
  const preload = read("electron/preload.js");
  const main = read("electron/main.js");
  assert.match(preload, /getEditorPerformanceMetrics\(\)[\s\S]*app:editor-performance-metrics/);
  assert.match(main, /ipcMain\.handle\("app:editor-performance-metrics"/);
  assert.match(main, /assertMainWindowSender\(event\)/);
  assert.match(main, /event\.sender\.getOSProcessId\(\)/);
  assert.match(main, /heapBytes/);
});

test("Android 注册 EditorPerformance 插件并从 WebView 读取 JS heap", () => {
  const activity = read("frontend/android/app/src/main/java/com/nowen/note/MainActivity.java");
  const plugin = read("frontend/android/app/src/main/java/com/nowen/note/EditorPerformancePlugin.java");
  assert.match(activity, /registerPlugin\(EditorPerformancePlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "EditorPerformance"\)/);
  assert.match(plugin, /@PluginMethod[\s\S]*getMemoryMetrics/);
  assert.match(plugin, /evaluateJavascript/);
  assert.match(plugin, /usedJSHeapSize/);
  assert.match(plugin, /heapBytes/);
  assert.doesNotMatch(plugin, /getTotalPss|Process\.myPid/);
});
