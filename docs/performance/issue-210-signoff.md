# Issue #210：Windows Electron 与 Web 性能签收

本文档用于签收 [#210](https://github.com/cropflre/nowen-note/issues/210)。目标不是用模拟数字证明“性能很好”，而是在真实 Web 与 Windows Electron 环境中生成可复核的 JSON 证据。

## 一、签收范围

必须同时提交两份结果：

- `web.json`：Chrome Web 版本；
- `electron.json`：Windows Electron 桌面版。

每份结果都必须包含：

1. 9 个编辑器性能场景；
2. 至少 3 次真实自动保存稳定性样本；
3. 同一图片首次打开、再次打开的资源记录；
4. 视频拖动进度条时的 `206 Partial Content` 记录。

Android 不属于 #210 的关闭门槛，现有性能协议仍保留 Android 矩阵供移动端专项使用。

## 二、生成固定测试数据

在仓库根目录执行：

```bash
npm run perf:editor-fixtures
```

生成目录：

```text
tmp/fixtures/editor-performance/
```

测试场景固定为：

- `markdown-2.4mb`
- `tiptap-20000`
- `tiptap-50000`
- `list-batch-100`
- `media-100`
- `media-500`
- `code-100`
- `code-500`
- `switch-20-and-close`

不要临时缩小数据规模，否则结果不能用于关闭 #210。

## 三、开启签收采集器

采集器默认关闭，不影响普通用户。以下三种方式任选其一：

### Web URL 参数

```text
https://你的站点/?issue210Perf=1
```

### 当前浏览器永久开启

在控制台执行后刷新：

```js
localStorage.setItem("nowen.issue210.signoff", "1");
location.reload();
```

关闭：

```js
localStorage.removeItem("nowen.issue210.signoff");
location.reload();
```

### 构建时开启

```bash
VITE_ISSUE_210_SIGNOFF=1 npm run build:frontend
```

开启成功后，控制台可访问：

```js
window.__NOWEN_ISSUE_210_SIGNOFF__
```

## 四、采集编辑器性能矩阵

项目已有统一性能入口：

```js
window.__NOWEN_EDITOR_PERF__
```

测试驱动必须实现 `frontend/src/lib/editorPerformanceHarness.ts` 中的 `EditorPerformanceHarnessDriver`。浏览器自动化或人工调试驱动打开固定测试笔记后，逐个执行 9 个场景。

示例：

```js
const signoff = window.__NOWEN_ISSUE_210_SIGNOFF__;
signoff.reset();

const run = await window.__NOWEN_EDITOR_PERF__({
  platform: "web", // Electron 使用 "electron"
  scenario: "tiptap-20000",
  driver,
});

signoff.recordPerformanceRun(run);
```

每个平台都必须记录全部 9 个场景。重复记录同一场景时，采集器会用最新结果替换旧结果。

## 五、自动保存稳定性

在普通可编辑笔记中执行：

1. 将光标放在正文中间；
2. 将页面滚动到非顶部位置；
3. 连续输入并等待自动保存完成；
4. 重复至少 3 次。

采集器会自动拦截笔记 `PUT/PATCH` 请求，并在保存响应完成后的两个绘制帧比较：

- 编辑器 DOM 实例是否被重新挂载；
- DOM Selection 路径和偏移量是否变化；
- 滚动位置变化；
- 保存期间的 Layout Shift。

关闭 #210 的门槛：

- 编辑器实例不变化；
- 选区不变化；
- 滚动偏移绝对值不超过 2px；
- 单次保存 Layout Shift 不超过 `0.01`；
- 保存请求必须返回 2xx。

## 六、图片缓存验证

准备一个包含本地附件图片的普通笔记，然后执行：

```js
const signoff = window.__NOWEN_ISSUE_210_SIGNOFF__;

signoff.markMediaPhase("first-open");
// 打开目标笔记，等待所有图片加载完成

signoff.markMediaPhase("second-open");
// 切换到其他笔记，再重新打开同一目标笔记
```

采集器通过 Resource Timing 记录附件请求。验证器会：

- 按稳定的 `/api/attachments/<id>` 路径匹配两次打开；
- 忽略签名 URL 中的 `exp/sig/scope` 参数做资源身份匹配；
- 要求第二次打开至少有一个 `transferSize = 0` 的内存或磁盘缓存命中；
- 要求第二次打开的总传输量不超过第一次的 25%，并提供 64 KiB 容差。

注意：身份匹配会忽略签名参数，但浏览器是否真正命中缓存仍以 Resource Timing 的实际传输量为准。

## 七、视频 Range 验证

打开包含本地视频附件的笔记：

```js
const signoff = window.__NOWEN_ISSUE_210_SIGNOFF__;
signoff.markMediaPhase("video-seek");
```

播放视频并拖动进度条到尚未缓冲的位置。至少需要观察到一条：

```text
responseStatus = 206
```

完整 `200` 下载不能替代 Range 验收。

## 八、导出结果

Web：

```js
window.__NOWEN_ISSUE_210_SIGNOFF__.download("web.json");
```

Windows Electron：

```js
window.__NOWEN_ISSUE_210_SIGNOFF__.download("electron.json");
```

也可直接查看：

```js
window.__NOWEN_ISSUE_210_SIGNOFF__.snapshot();
```

## 九、自动校验

仓库根目录执行：

```bash
npm run validate:issue-210-signoff -- web.json electron.json
```

验证器会检查：

- Web 与 Electron 两个平台是否齐全；
- 9 个性能场景是否全部执行；
- 桌面输入延迟 P50 是否不超过 16ms；
- 桌面输入延迟 P95 是否不超过 50ms；
- Long Task 是否不超过 200ms；
- 关闭笔记后 Worker、NodeView 和媒体请求是否归零；
- 自动保存是否保持实例、光标和滚动稳定；
- 图片是否真实命中缓存；
- 视频是否产生 `206` Range 响应。

校验器自身测试：

```bash
npm run test:issue-210-signoff
```

## 十、Issue 关闭规则

满足以下条件后才能关闭 #210：

- `web.json` 校验通过；
- `electron.json` 校验通过；
- 两份结果来自实际运行环境，不是测试中构造的模拟对象；
- 结果文件或关键摘要附在 #210 评论中；
- 人工确认自动保存期间无可感知光标跳动和页面抽动。

代码合并只代表签收工具可用，不代表 #210 自动完成。真实结果未通过前应继续保持 Issue 为 Open。
