# nowen-note 图标系统

一套为 nowen-note 专门定制的矢量图标方案，与品牌 Logo（`/nowen-note-icon.svg`）共享同一视觉语言。

## 设计规范

| 项目       | 规格                                                           |
| ---------- | -------------------------------------------------------------- |
| viewBox    | `0 0 24 24`                                                    |
| 网格对齐   | 24×24 像素网格，元素保留 1px 内边距                            |
| 描边宽度   | `stroke-width="2"`，`stroke-linecap="round"`、`-linejoin="round"` |
| 填充       | 默认线性（fill="none"）；品牌主图标使用双色填充                 |
| 主色 Token | `--color-accent-primary` → `#3B82F6`（深色 `#2563EB`）         |
| 辅助色     | `#22C55E`（成功/标签）、`#F59E0B`（笔尖/警示）、`#EF4444`（危险） |
| 中性色     | `currentColor`（线性图标默认继承文本色）                       |

## 推荐尺寸

| 场景                        | 尺寸                |
| --------------------------- | ------------------- |
| 侧边栏导航                  | 20px                |
| 工具栏按钮                  | 16–18px             |
| 模态标题 / 空状态图示       | 24–32px             |
| 应用图标 / 启动屏           | 512×512（来自 logo）|
| Favicon                     | 32×32 / 16×16       |

## 使用方式

### React 组件中直接引用

```tsx
// 作为 <img /> 使用（不需要跟随文本色）
<img src="/icons/notebook.svg" width={20} height={20} />

// 作为 SVG 内联（需要跟随 currentColor 变色）
// 已将 stroke 设置为 currentColor，可直接注入或通过 SVGR 引入
```

### 通过 Sprite 按需复用

使用 `sprite.svg` 可一次加载、多次引用，减少请求数：

```tsx
<svg className="w-5 h-5 text-blue-500"><use href="/icons/sprite.svg#notebook" /></svg>
```

## 图标清单

### 导航与模块（Navigation）

| 名称          | 文件                      | 含义              |
| ------------- | ------------------------- | ----------------- |
| notebook      | `notebook.svg`            | 笔记本            |
| note          | `note.svg`                | 笔记              |
| tag           | `tag.svg`                 | 标签              |
| task          | `task.svg`                | 任务              |
| mindmap       | `mindmap.svg`             | 思维导图          |
| moment        | `moment.svg`              | 说说 / 动态       |
| search        | `search.svg`              | 搜索              |
| trash         | `trash.svg`               | 回收站            |
| favorites     | `favorites.svg`           | 收藏              |
| history       | `history.svg`             | 版本历史          |

### 协作与 AI（Collaboration & AI）

| 名称          | 文件                      | 含义              |
| ------------- | ------------------------- | ----------------- |
| ai-assistant  | `ai-assistant.svg`        | AI 助手           |
| share         | `share.svg`               | 分享              |
| comment       | `comment.svg`             | 评论 / 批注       |
| user          | `user.svg`                | 用户              |
| users         | `users.svg`               | 用户管理          |
| webhook       | `webhook.svg`             | Webhook           |

### 操作（Actions）

| 名称          | 文件                      | 含义              |
| ------------- | ------------------------- | ----------------- |
| add           | `add.svg`                 | 新建 / 添加       |
| edit          | `edit.svg`                | 编辑              |
| save          | `save.svg`                | 保存              |
| delete        | `delete.svg`              | 删除              |
| import        | `import.svg`              | 导入              |
| export        | `export.svg`              | 导出              |
| sync          | `sync.svg`                | 同步              |
| backup        | `backup.svg`              | 备份              |
| settings      | `settings.svg`            | 设置              |
| plugin        | `plugin.svg`              | 插件              |

### 展示（Display）

| 名称          | 文件                      | 含义              |
| ------------- | ------------------------- | ----------------- |
| brand         | `brand.svg`               | 品牌图标（小尺寸） |

完整 sprite 汇总见 `sprite.svg`。
