# 编辑器视频控件事件隔离实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 阻止 ProseMirror 接管编辑器内原生视频控件和视频工具栏的事件，使暂停、全屏、下载等操作在 PC 桌面版恢复响应。

**架构：** 在 `VideoExtension` 内定义一个小型 NodeView 事件边界函数，并将它作为 `ReactNodeViewRenderer` 的 `stopEvent` 选项。仅视频元素和自定义工具栏截止事件，视频节点其他区域仍由 ProseMirror 处理，因此选择、拖拽和 iframe 遮罩行为不变。

**技术栈：** React 18、Tiptap 3、ProseMirror、TypeScript、Vitest、jsdom

---

## 文件结构

- 修改：`frontend/src/components/VideoExtension.tsx` —— 定义视频交互事件边界、标记工具栏并接入 NodeView renderer。
- 修改：`frontend/src/components/__tests__/VideoExtension.test.ts` —— 覆盖原生视频、工具栏子元素和普通节点容器三类事件目标。

### 任务 1：用回归测试固定视频 NodeView 的事件边界

**文件：**
- 修改：`frontend/src/components/__tests__/VideoExtension.test.ts`

- [ ] **步骤 1：编写失败的测试**

将模块导入改为命名空间导入，并添加用于产生真实 DOM 事件的测试辅助函数：

```ts
import * as VideoExtension from "@/components/VideoExtension";

const { getVideoDisplayStyle, Video } = VideoExtension;

function getStopDecision(target: Element): boolean | undefined {
  let decision: boolean | undefined;
  target.addEventListener(
    "mousedown",
    (event) => {
      decision = (
        VideoExtension as typeof VideoExtension & {
          shouldStopVideoNodeEvent?: (props: { event: Event }) => boolean;
        }
      ).shouldStopVideoNodeEvent?.({ event });
    },
    { once: true },
  );
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return decision;
}
```

在现有测试文件末尾添加三个独立行为测试：

```ts
describe("VideoExtension NodeView events", () => {
  it("keeps native video control events away from ProseMirror", () => {
    const video = document.createElement("video");

    expect(getStopDecision(video)).toBe(true);
  });

  it("keeps toolbar descendant events away from ProseMirror", () => {
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-video-toolbar", "");
    const icon = document.createElement("span");
    toolbar.append(icon);

    expect(getStopDecision(icon)).toBe(true);
  });

  it("leaves ordinary video node events to ProseMirror", () => {
    const wrapper = document.createElement("div");

    expect(getStopDecision(wrapper)).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd frontend
npm run test:run -- src/components/__tests__/VideoExtension.test.ts
```

预期：新增的前两个测试 FAIL，收到 `undefined` 而不是 `true`，证明当前模块没有视频交互事件隔离逻辑；既有上传和尺寸测试继续通过。

### 任务 2：实施最小 NodeView 事件隔离

**文件：**
- 修改：`frontend/src/components/VideoExtension.tsx:177-528`
- 测试：`frontend/src/components/__tests__/VideoExtension.test.ts`

- [ ] **步骤 1：定义事件边界函数**

在视频显示样式函数之后添加：

```ts
export function shouldStopVideoNodeEvent({ event }: { event: Event }): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("video, [data-video-toolbar]"));
}
```

- [ ] **步骤 2：标记自定义工具栏**

为视频工具栏容器添加稳定属性：

```tsx
<div
  data-video-toolbar
  contentEditable={false}
  style={videoToolbarOverlayStyle}
>
```

- [ ] **步骤 3：将事件边界接入 React NodeView renderer**

修改 `addNodeView`：

```ts
addNodeView() {
  return ReactNodeViewRenderer(VideoNodeView, {
    stopEvent: shouldStopVideoNodeEvent,
  });
},
```

- [ ] **步骤 4：运行目标测试验证通过**

运行：

```powershell
cd frontend
npm run test:run -- src/components/__tests__/VideoExtension.test.ts
```

预期：7 个测试全部 PASS，其中 3 个事件边界测试分别证明视频控件和工具栏被隔离、普通容器仍交给 ProseMirror。

- [ ] **步骤 5：提交实现**

```powershell
git add -- frontend/src/components/VideoExtension.tsx frontend/src/components/__tests__/VideoExtension.test.ts
git commit -m "fix(editor): 恢复视频控件交互"
```

### 任务 3：验证回归范围

**文件：**
- 验证：`frontend/src/components/VideoExtension.tsx`
- 验证：`frontend/src/components/__tests__/VideoExtension.test.ts`

- [ ] **步骤 1：运行目标 ESLint**

运行：

```powershell
cd frontend
npx eslint src/components/VideoExtension.tsx src/components/__tests__/VideoExtension.test.ts
```

预期：退出码为 0，无 lint 错误。

- [ ] **步骤 2：运行相关视频与编辑器测试**

运行：

```powershell
cd frontend
npm run test:run -- src/components/__tests__/VideoExtension.test.ts src/lib/__tests__/markdownVideoSyntax.test.ts
```

预期：本次视频事件测试和既有视频 Markdown 测试全部 PASS；若存在基线失败，记录具体用例并确认与本次差异无关。

- [ ] **步骤 3：运行 TypeScript 与生产打包**

运行：

```powershell
cd frontend
npx tsc -b --pretty false
npx vite build
```

预期：Vite 生产打包退出码为 0。TypeScript 若仍只报告已知的 `src/store/AppContext.tsx:351` 中 `number` 与 `Timeout` 不兼容，则记录为既有阻塞，不将其归因于本次视频修复。

- [ ] **步骤 4：检查最终差异**

运行：

```powershell
git diff --check
git status --short
git show --stat --oneline HEAD
```

预期：实现提交只包含视频扩展和对应测试；工作区原有 PDF 修改及其他未跟踪文件保持不变。
