# 顶部笔记标签快速切换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面端顶部标签栏提供始终可见的全部标签入口，使用户能从竖向列表快速切换或关闭已打开笔记。

**架构：** `NoteTabsBar` 继续负责标签状态和切换逻辑，新增一个固定在横向滚动区外的按钮及 Portal 弹层。测试通过 mock 应用状态和 API，直接验证弹层交互，不改变全局状态结构或后端偏好。

**技术栈：** React 18、TypeScript、Vitest、jsdom、Tailwind CSS、react-i18next

---

## 文件结构

- 创建：`frontend/src/components/__tests__/NoteTabsBar.test.tsx`，覆盖全部标签弹层的打开、切换、关闭和键盘收起。
- 修改：`frontend/src/components/NoteTabsBar.tsx`，增加固定入口、弹层状态及交互。
- 修改：`frontend/src/i18n/locales/zh-CN.json`，增加中文入口及数量文案。
- 修改：`frontend/src/i18n/locales/en.json`，增加英文入口及数量文案。

### 任务 1：全部标签竖向列表

**文件：**
- 创建：`frontend/src/components/__tests__/NoteTabsBar.test.tsx`
- 修改：`frontend/src/components/NoteTabsBar.tsx`
- 修改：`frontend/src/i18n/locales/zh-CN.json`
- 修改：`frontend/src/i18n/locales/en.json`

- [ ] **步骤 1：编写失败的组件测试**

使用 `vi.mock` 提供两条 `openNoteTabs`、当前笔记、`useAppActions` 和 `api.getNote`。渲染组件后断言：

```tsx
const switcher = document.querySelector<HTMLButtonElement>(
  '[aria-label="editorTabs.allOpenedTabs"]',
);
expect(switcher).not.toBeNull();

await act(async () => switcher!.click());
expect(document.querySelector('[data-testid="note-tabs-switcher"]')).not.toBeNull();
expect(document.body.textContent).toContain("笔记一");
expect(document.body.textContent).toContain("笔记二");
```

再验证点击第二项调用 `api.getNote("note-2")`，点击其关闭按钮调用 `closeNoteTab("note-2")`，按 `Escape` 后弹层消失。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
npm run test:run -- src/components/__tests__/NoteTabsBar.test.tsx
```

预期：FAIL，因为尚不存在 `editorTabs.allOpenedTabs` 按钮和 `note-tabs-switcher` 弹层。

- [ ] **步骤 3：实现最少交互**

在 `NoteTabsBar` 中加入弹层状态和引用：

```tsx
const [tabListMenu, setTabListMenu] = useState<{ x: number; y: number } | null>(null);
const tabListMenuRef = useRef<HTMLDivElement | null>(null);
```

横向滚动区之后增加固定按钮，点击时用按钮矩形记录弹层位置。Portal 列表对 `openNoteTabs` 映射渲染，切换时复用 `openNote`，关闭时复用 `closeTab`。把弹层引用加入现有点击外部和 `Escape` 关闭逻辑。

中英文增加：

```json
"allOpenedTabs": "全部已打开标签",
"openedTabCount": "已打开 {{count}} 个标签"
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```powershell
npm run test:run -- src/components/__tests__/NoteTabsBar.test.tsx
```

预期：PASS，测试文件全部通过。

- [ ] **步骤 5：运行相关回归与构建**

运行：

```powershell
npm run test:run -- src/components/__tests__/NoteTabsBar.test.tsx src/lib/__tests__/userPreferenceAccountCache.test.ts
npm run build
git diff --check
```

预期：命令退出码均为 0。

- [ ] **步骤 6：提交实现**

```powershell
git add -- frontend/src/components/NoteTabsBar.tsx frontend/src/components/__tests__/NoteTabsBar.test.tsx frontend/src/i18n/locales/zh-CN.json frontend/src/i18n/locales/en.json
git commit -m "feat(标签栏): 添加全部标签快速切换"
```
