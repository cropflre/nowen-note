# 1.6.0 扩展体验发布检查报告（Phase 5）

- 检查对象：`release/v1.6.0` 最新提交 `532389bd4`（#926 扩展中心改版：发现 / 我的 / 工作台 + 创建，管理员高级能力移到「设置 › 扩展管理」），以及叠在它上面的 Phase 5 修复分支 `feat/extension-platform-phase5-v16`。
  - 安全审计和后端回归最初在 `63f6af1b9` 上完成。#926 只改了前端，所以后端结果不受影响。
  - 前端单测、E2E、包体、无障碍审计和截图都在移植到 `532389bd4` 之后重新运行。
- 检查日期：2026-11-15，2026-11-16 移植到最新 release 后复测。
- 范围：扩展中心、工作台、编辑器扩展动作、创建应用，以及它们依赖的 V3 应用运行时。

本阶段**不发版**，也不修改发布配置。

## 结论

| 检查项 | 结论 | 说明 |
| --- | --- | --- |
| 安全回归（方案 §12.4） | **通过，有 1 项剩余风险待决策** | 未发现数据损坏、权限绕过、凭据泄露、绕过签名安装。V3 插件界面仍可经 WebRTC 向外发数据，见 [D8](#待你决定) |
| 功能闭环（方案 §12.2） | 通过 | 10 个闭环都有自动化证据，其中第 10 项桌面成品需人工验收 |
| Web | 通过 | Chromium 下 6 个扩展 E2E 全部通过 |
| 桌面端（Electron） | **部分通过，成品需人工验收** | 发现并修复：V3 页面在桌面端一直是空白；补上桌面端插件 iframe 跳转外传的拦截。产品外壳在本机自动化环境中无法驱动，完整流程未测 |
| Android / iOS | **需真实设备验收** | 代码与单测确认不显示入口、不发请求；没有真机运行 |
| Docker / NAS | **需真实设备验收** | 未在容器或 NAS 上运行 |
| 性能 | 通过 | 扩展代码不在主 App chunk 中；编辑器输入延迟开、关编辑器动作没有可测差异 |
| 无障碍 | 扩展页面通过；**全站对比度未通过（P2）** | 修复 3 处缺失的控件名称；全站颜色令牌对比度不足，需要设计决策 |
| 功能开关与旧版兼容 | 通过 | 开关默认值与回退行为均有测试；1.6.0 不能直接降级到 1.5.5（数据库版本保护），只能恢复备份 |
| 文档 | 已提供 | [使用教程](./extension-center-user-guide.md)、[插件作者指南](./plugin-author-guide-v16.md)（含 SDK 示例）、[迁移与回滚](./extension-experience-v16-rollback.md) |

建议：**可以进入 1.6.0 发版候选**，前提是你确认以下事项：

1. [D8](#待你决定) 的剩余风险可以接受；
2. 做出 [D1、D3](#待你决定) 的决定；
3. 在真机和桌面成品上完成[需人工验收](#未验证范围与人工验收清单)的项目。

## Release Gate

| 阻断条件 | 结果 | 证据 |
| --- | --- | --- |
| 用户笔记数据损坏 | 未发现 | 编辑器动作只经一次编辑器事务写入，运行期间改动过的选区不会被覆盖（E2E + 适配器单测）。伪造加密块、孤立代理项（本阶段新增）、超过 64 KiB 的结果都会被拒绝 |
| 权限隔离绕过 | 未发现 | 普通用户安装、授权、启用均返回 403；工作区 A/B、账号切换、权限撤销后旧会话立即失效（后端路由测试 + E2E） |
| 凭据暴露 | 未发现 | iframe 读不到宿主 DOM、localStorage、Token、Electron preload；会话票据只能用一次；执行记录里没有选区正文 |
| 插件安装绕过签名 | 未发现 | 篡改签名、哈希不一致、未知官方源、元数据回滚都会被拒绝（Registry 测试） |
| 已知 iframe 严重隔离缺口 | **部分关闭，剩 1 项** | 本阶段关闭了桌面端“自身导航外传”。WebRTC 外传和只用 meta CSP 的部署仍有风险，见 [D8](#待你决定) |
| 跨设备数据静默覆盖 | 未发现 | 工作台布局只存在本机；编辑器动作走原有保存、Yjs 和 Sync V2 链路，不新增写入接口 |

## 安全验收（方案 §12.4）

后端扩展相关的 27 个测试文件、99 项用例，在 Phase 5 修复前全部运行：98 项通过，1 项失败是已知的 D1 版本号基线（`application-v3-foundation`）。修复后的结果见[验证记录](#验证记录)。

| 方案要求 | 证据 | 结果 |
| --- | --- | --- |
| 恶意包路径穿越 | `plugin-platform`（Zip Slip、native addon、main 越界）；`application-v3-foundation`（UI 资源篡改、未声明、不安全路径）；`plugin-studio-projects`（软链接、硬链接、目录替换） | 通过 |
| 篡改签名、哈希不一致 | `extension-platform-v2`（Ed25519 篡改）；`extension-center-registry-routes`（`REGISTRY_CHECKSUM_MISMATCH`、伪造包、签名失效）；`extension-registry-supply-chain-e2e` | 通过 |
| Registry 可信源配置错误 | `extension-ecosystem-rc1`（未知官方源 fail-closed、元数据回滚、双重签发）；`extension-center-registry-routes`（公钥不匹配 → `REGISTRY_SIGNATURE_INVALID`） | 通过 |
| 未授权 Host API 调用 | `plugin-platform`（未声明权限）；`extension-platform-v2`（沙箱只暴露 Broker）；`editor-actions`（缺授权 → `PLUGIN_PERMISSION_DENIED`） | 通过 |
| 跨工作区资源 ID | `application-v3-runtime`（外部工作区、用户、插件互相隔离；客户端 scope 被拒绝）；`application-v3-dashboard-data`；`editor-actions`（不存在、无权访问、回收站返回同一错误） | 通过 |
| 权限更新或撤销后继续使用旧会话 | `application-v3-runtime`（降权后 SSE 推送 revoked，调用被拒）；`application-v3-foundation`（立即撤销）；`application-v3-inspector`；`plugin-inbound`（凭据撤销后回调不再执行） | 通过 |
| iframe 读取父页面 DOM、Token、native bridge | `plugin-apps` E2E（访问 parent、localStorage、`nowenDesktop`、`require` 均失败） | 通过 |
| iframe 访问任意外部网络 | `fetch` 被 CSP `connect-src` 拦截（E2E）。自身导航到外部：**Web 端由宿主 `frame-src` 拦截（本阶段新增 E2E 断言）**；**桌面端本阶段修复**（见下文）。WebRTC：**可外发**（实测） | **部分通过（D8）** |
| 伪造消息、超频调用 | `pluginApps` 单测（伪造身份被拒）；`application-v3-foundation`（并发、去重、重放、速率）；`extension-sandbox-attack-matrix`（参数超限、32 并发、事件洪泛、IPC 超限） | 通过 |
| AI 插件执行任意代码、请求密钥或全盘文件、读整库正文 | QuickJS 沙箱测试（隐藏 Node 与浏览器全局对象、构造器逃逸、原型污染）；`editor-actions`（Prompt 动作只用宿主 AI，不运行插件代码；命令动作只拿到提交的选区）；`personal-studio-ai`（只把字段结构交给 AI，拒绝可执行载荷） | 通过 |
| 恶意结果：HTML/script、超长、非法 Unicode/Markdown | 后端拒绝超过 64 KiB 的结果和**孤立代理项（本阶段新增）**。前端：富文本去掉脚本、事件属性和 `javascript:`，Markdown 编辑器原样插入源文本（本阶段新增单测）。上限内构造的 Markdown 最坏让编辑器卡约 1.4 秒（jsdom 实测，P2） | 通过（附 P2） |
| 编辑器写入：用户授权、资源 ACL、修订验证、事务与撤销 | `editor-actions`（ACL、锁定、加密、密码保护、编辑器类型）；适配器单测（快照、映射、过期拒绝、一次撤销）；`editor-actions` E2E（两种编辑器写入、保存、撤销、重做、运行中改字被拒） | 通过 |

### 本阶段发现并修复

1. **桌面端 V3 页面一直是空白**（1.5.3 起就存在）。
   - 原因：桌面客户端从 `file://` 加载界面，而插件文档响应头是 `frame-ancestors 'self'`，被 Electron 43 拦截（真实 Electron 实测）。
   - 修复：只对 `platform=desktop` 会话的一次性文档，增加 `file:` 嵌入方，并去掉 `X-Frame-Options`。Web 会话不变。
2. **桌面端插件 iframe 可以把自己导航到外部网址带出数据**。
   - 原因：桌面页面的 meta CSP `frame-src` 放行任意 http/https。修复第 1 项后，这个通道随之打开。
   - 修复：Electron 主进程通过 `will-frame-navigate` 拦截插件 frame 自己或其子 frame 发起的导航；宿主页面替换 frame 不受影响。
   - 验证：真实 Electron 43 中，不加拦截时外部接收端收到了 `/leak?secret=…`；加拦截后没有收到，frame 停留在原文档。
3. **编辑器动作结果可含孤立的 UTF-16 代理项**，保存时会被悄悄改成 U+FFFD。现在由服务器拒绝。
4. **几个控件没有无障碍名称**：
   - 创建应用编辑器里的字段类型下拉框：已补上，并加了 E2E 断言；
   - 「设置 › 扩展管理」插件行里只有图标的“重新加载”和“卸载”按钮：已补上，新增翻译键 `extensionCenter.action.reload`。

## 功能闭环（方案 §12.2）

| # | 闭环 | 证据 | 结果 |
| --- | --- | --- | --- |
| 1 | 管理员：搜索 → 权限 → 安装 → 授权 → 启用 → 已启用 | `extension-center` E2E（测试签名源，只替换传输层） | 通过 |
| 2 | 普通用户看到限制，不能绕过后台安装 | `extension-center` E2E + Registry 路由 403 | 通过 |
| 3 | 工作台：内置卡加第三方卡，拖动、调尺寸、刷新保留，停用变休眠、重新启用恢复 | `workbench` E2E | 通过 |
| 4 | Tiptap `/` 插入 → 保存刷新 → 撤销 | `editor-actions` E2E | 通过 |
| 5 | Markdown 同一命令 → 保存刷新 → 撤销、重做 | `editor-actions` E2E | 通过 |
| 6 | 异步 AI → 预览 → 替换，中途改字后旧结果被拒 | `editor-actions` E2E（AI 由确定性桩代替） | 通过 |
| 7 | 加密锁定、只读共享、未授权插件被服务端拒绝，正文不变 | `editor-actions` 后端测试 + E2E（锁定笔记不显示菜单） | 通过 |
| 8 | 账号 A/B、工作区切换不串数据 | `workbench`、`create-app` E2E，`pluginDashboard` 单测，`application-v3-runtime` | 通过 |
| 9 | 更新、新增权限、回滚、保留卸载、重装、备份恢复隔离 | `plugin-update-recovery-matrix`、`extension-center-registry-routes`、`application-v3-dashboard-data`、`personal-studio-backup-restore` | 通过 |
| 10 | Web、Electron 完整流程，移动端降级 | Web E2E；Electron 关键路径实测（见[跨平台](#跨平台)）；原生端单测 | Web 通过；**桌面成品、真机需人工** |

## 跨平台

| 平台 | 结果 | 依据 |
| --- | --- | --- |
| Web（Chromium，桌面宽度与 390px） | 通过 | 6 个扩展 E2E；390px 无横向滚动；深色、浅色 |
| Electron 43.8.4 / Chromium 150（开发构建） | 关键路径通过 | 最小桌面外壳中加载真实插件文档：修复前被拒、修复后加载；跳转拦截生效；宿主替换 frame 正常 |
| 桌面成品（electron/main.js 完整外壳） | **需人工验收** | 在本机自动化环境中，渲染进程启动后无响应（CPU 约 0，CDP 无响应，禁用 GPU 无改善）。修改代码之前就已如此，与本阶段改动无关，原因未定位 |
| Android / iOS | **需真实设备验收** | `usePluginApps`、`useEditorActions` 单测：原生端不显示入口、不发请求；没有真机运行 |
| Docker / NAS、反向代理部署 | **需真实设备验收** | 只用前端 meta CSP 部署（不经后端返回页面）时，插件可经自身导航外传，见 D8 |

桌面端完整流程的人工验收步骤：

1. 用 1.6.0 桌面成品连接 1.6.0 服务器，安装 Hello Nowen App；
2. 打开应用，保存一条消息，重启后数据仍在；
3. 停用后页面关闭，重新启用恢复；
4. 工作台添加插件卡片；
5. 选中文字运行编辑器动作，确认可以撤销。

## 性能

**包体**（`npm run build`，移植到 532389bd4 后测量，与 Phase 0 基线 088e78469 对比；这段时间内其他 1.6.0 改动，包括 #926，也在变化）：

| 文件 | Phase 0 | 现在 | 说明 |
| --- | --- | --- | --- |
| 首屏 JS（`verify:bundle`） | 4 个请求 / 1.61 MiB / gzip 504.6 KiB | 1 个请求 / 14.5 KiB / gzip 5.4 KiB | 入口改为懒加载，属于其他 1.6.0 改动；预算通过 |
| App | 1,226.79 kB（gzip 335.73） | 1,248.31 kB（gzip 342.09） | source map 归因：扩展平台代码 0 字节（在 63f6af1b9 上归因） |
| TiptapEditorInitializationRuntime | 536.85 kB（gzip 164.82） | 546.72 kB（gzip 168.43） | 其中编辑器动作 16.5 KiB |
| PluginApps | 47.45 kB | 100.72 kB（gzip 29.87） | 扩展中心与创建应用，懒加载 |
| PluginDashboard | — | 34.06 kB（gzip 10.38） | 工作台，懒加载 |
| PluginSettingsTab、CommandPalette | 38.29 / 40.96 kB | 35.29 / 40.65 kB | #926 去掉了设置页里重复的插件市场 |

按 source map 归因，扩展平台代码共约 169.5 KiB（压缩后）：

- **只在打开扩展页面时加载**：扩展中心 91.1 KiB、工作台 31.9 KiB；
- **打开编辑器时加载**：富文本 16.5 KiB、Markdown 2.6 KiB；
- **启动时加载**：i18n chunk 里的中英文文案 27.4 KiB（P2：可以改成随扩展中心懒加载）。

**编辑器输入延迟**：无头 Chromium，300 段的长笔记，每种编辑器每轮 210 次按键，统计“按下按键到下一帧之后”的耗时，两轮结果如下：

| 编辑器动作 | Markdown p50 / p95 | 富文本 p50 / p95 |
| --- | --- | --- |
| 关闭（默认） | 14.1 / 21.1、13.1 / 21.0 ms | 11.7 / 19.2、12.2 / 19.6 ms |
| 开启（装 2 个插件，菜单已挂载） | 13.6 / 21.0、13.1 / 20.7 ms | 11.0 / 19.5、11.3 / 18.9 ms |

两组差异在噪声以内。E2E 另外断言：两种编辑器中输入文字时，不会产生任何 `/api/plugins` 请求。动作列表每个会话只请求一次，所有编辑器共用，插件变化后才重新获取（单测）。

**按需加载与轮询**：

- 扩展中心目前不展示截图，因为 Registry 展示字段 D5 未定。
- 工作台没有逐卡轮询：第三方卡片共用一条 `widget-events` 推送流，内置卡片在数据变化时刷新。
- 没有做视口外延迟挂载（最多 12 张卡，P2）。

## 无障碍

自写的 Playwright 审计（仓库里没有 axe，本阶段也不引入新依赖），在移植到 532389bd4 后的界面上重新运行，覆盖以下范围：

- **页面状态**（12 个）：我的（`/apps` 和旧链接 `/apps/manage`）、我的卡片「···」菜单、发现、详情、设置 › 扩展管理、工作台（查看 / 编辑 / 添加卡片）、创建（入口 / 草稿）、编辑器动作菜单；
- **主题**：深色、浅色；
- **宽度**：1440（100%）、1152（≈125%）、960（≈150%）、390px。

| 检查 | 结果 |
| --- | --- |
| 页面横向滚动 | 所有组合都没有。窄屏下的分类条、设置标签条是可横向滚动的容器 |
| 控件无障碍名称 | 已修复 3 处：创建应用的字段类型下拉框（E2E 断言）；「设置 › 扩展管理」插件行里只有图标的“重新加载”和“卸载”按钮（2026-09/10 就有，#926 把这个页面挪进设置后审计才扫到）。剩下的都是全站共用控件（P2）：窄屏顶栏菜单按钮（`NoteList.tsx`）、设置弹窗的关闭按钮（`SettingsModal`）、Markdown 编辑区本身（CodeMirror 的 textbox） |
| 键盘焦点 | 每页 Tab 18 次，所有停留点都有可见焦点环；菜单按 Escape 返回触发按钮（单测） |
| 减少动态效果 | `prefers-reduced-motion` 下过渡和动画时长被压到约 1 µs（全局 CSS 规则加 `MotionConfig`） |
| 文字对比度（近似计算） | **全站颜色令牌未达 WCAG AA（P2）**：白字配强调色按钮，深色 2.53:1、浅色 3.68:1；三级文字，深色 3.77:1、浅色 2.43:1；设置弹窗标题处的产品名 2.57:1。不是扩展页面独有的问题 |
| 屏幕阅读器实测 | 未做（VoiceOver、NVDA 需人工） |

## 功能开关与旧版兼容

- **`NOWEN_EDITOR_ACTIONS`**：默认关闭。
  - 关闭时，`/contributions` 不返回编辑器动作，执行接口返回 403，含编辑器动作的包安装被拒；
  - 安装后再关闭，菜单消失，插件和数据保留（后端测试）；
  - 前端在开关关闭或原生端时不请求插件贡献（单测）。
- **V3 开关**：默认值 core、appPages、dashboardWidgets、pluginData 为开，inspectors 为关。E2E 会核对 `/plugins/features` 的返回值；关闭 appPages 后不能安装 V3 应用、会话被拒、数据保留。
- **V1、V2、V3 清单**：V1、V2 插件继续可用，有对应测试。
- **个人应用**：1.5.5 时代没有历史版本的应用会自动补齐历史，有对应测试。
- **数据库**：扩展平台没有新增迁移。1.6.0 的迁移中心新增 5 个迁移，所以 1.5.5 遇到 1.6.0 的库会拒绝启动，只能恢复升级前的备份。详见[迁移与回滚](./extension-experience-v16-rollback.md)。

## 验收用户故事（方案 §16）

| 故事 | 结果 | 说明 |
| --- | --- | --- |
| A 普通用户安装写作助手 | **部分通过** | 管理员路径完整（安装、授权、选区出现「AI 润色」「AI 翻译为英文」、停用后菜单在当前客户端立即消失、笔记不变）。普通用户“申请授权”未实现（D6）；其他已打开的客户端要到下次加载才隐藏菜单，但在此之前执行会被服务器拒绝 |
| B 定制工作台 | 通过 | `workbench` E2E |
| C 双编辑器真实执行 | 通过 | `editor-actions` E2E |
| D AI 自定义应用 | 通过（模型为确定性桩） | `create-app` E2E；真实模型未测 |
| E 服务端与数据安全 | 通过 | 见安全验收与 Release Gate |

## 待你决定

| 编号 | 事项 | 建议 |
| --- | --- | --- |
| D1 | 插件宿主版本 `NOWEN_VERSION` 仍是 1.5.3：`application-v3-foundation` 一项长期红灯；要求 `>=1.6.0` 的声明式合同会被拒绝 | 在发版准备时与产品版本对齐到 1.6.0，并同步更新该测试和示例的 `engines` |
| D3 | 编辑器动作是否默认开启 | 安全验收已通过，菜单只在管理员装了相应插件后才出现。建议 1.6.0 默认开启；保守做法是保持关闭、由管理员按需开启 |
| D5 | Registry 展示字段与示例插件发布 | 未变，仍由你决定 |
| D6 | 普通用户“申请安装” | 未变。故事 A 的普通用户路径依赖它 |
| D7 | 现有 AI 写作助手按选区替换的覆盖风险 | 未变，建议独立修复，复用编辑器动作的锚点校验 |
| **D8（新）** | V3 插件界面仍可经 WebRTC 外发数据；只用前端 meta CSP 部署时，还能经自身导航外发。插件界面能拿到的只有自己的存储、它自己界面里的输入和上下文，拿不到笔记、任务和凭据；资源检查器（能看到单个资源）默认关闭 | 1.6.0 维持“只运行管理员安装的插件”的信任模型，在文档中写明（已写）。部署指南要求经后端提供页面，或在反向代理上加同等 `frame-src`。向不可信市场开放前，必须解决这个通道，或把 V3 UI 限定为可信来源 |
| P2 | 全站对比度令牌；三个全站控件缺名称（窄屏顶栏菜单按钮、设置弹窗关闭按钮、Markdown 编辑区）；扩展文案懒加载；工作台视口外延迟挂载；上限内构造的 Markdown 约 1.4 秒卡顿 | 作为 1.6.x 体验优化 |

## 验证记录

以下都是本机（macOS，Electron 43.8.4 内置的 Node 作为后端运行时，`TZ=Asia/Shanghai`）的实际运行结果。

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 后端全量（串行，每个文件一个进程） | `cd backend && TMPDIR=<短路径> TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 <Electron> scripts/run-tests-serial.mjs` | 430 个文件：426 个通过，4 个失败。4 个均为基线：`application-v3-foundation`（D1）、`mcp-embedded`（DCC-006）、`migration-release-upgrade`（需要先构建后端）、`workspace-issues`（在未改动的 release 63f6af1b9 上同样失败） |
| 后端扩展安全专项 | 同上，逐个运行 27 个扩展测试文件 | 修复前 99 项中 98 项通过（1 项为 D1）；修复后 `application-v3-runtime`、`editor-actions` 新增断言全部通过 |
| 后端 TypeScript | `cd backend && node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| Electron 单测 | `node --test electron/__tests__/*.test.js` | 88/88 通过（新增 2 项跳转拦截用例） |
| 前端单测全量 | `cd frontend && TZ=Asia/Shanghai npx vitest run` | 移植前 788 个文件、4761 项全部通过。移植到 532389bd4 后为 787 个文件、4758 项，只有 1 项失败：`MobileNavigationRail.test.ts` 按源码字面匹配 `<SettingsModal onClose=…/>`，而 #926 给它加了 `defaultTab`。“隐藏导航栏后仍能打开设置”的行为没有变，已单独提交 7bd73ae80 更新这条断言，重跑 5/5 通过。新增的 `usePluginApps`、`useEditorActions` 钩子测试和 2 项恶意结果适配器测试均通过 |
| 前端 TypeScript | `cd frontend && npx tsc -p tsconfig.app.json --noEmit` | 通过 |
| 前端 lint（改动文件） | `npx eslint <改动文件>` | 0 个错误；2 条警告是 `PersonalStudio.tsx` 原有的 hook 依赖警告 |
| i18n | `npm run i18n:check` | 通过 |
| SDK 合同 | `node scripts/generate-plugin-host-api.mjs --check`；SDK `tsc`；`generated-contract.test.mjs` | 全部通过 |
| 数据一致性契约 | `node scripts/data-consistency-contract.mjs --verify` | 通过（12 条不变量 / 349 处测试引用） |
| 生产构建与包体预算 | `npm run build && npm run verify:bundle` | 通过（首屏 1 个请求 / 14.5 KiB / gzip 5.4 KiB） |
| 扩展 E2E（Chromium） | 打包 5 个示例插件后 `NOWEN_QA_NODE=<Electron> npx playwright test --config playwright.plugin-apps.config.ts` | 移植到 532389bd4 并加上扩展管理页的名称修复后，6/6 通过（1.2 分钟）：plugin-apps（新增外部跳转外传断言）、plugin-inspectors、extension-center、workbench、editor-actions（新增输入不请求插件接口的断言）、create-app（新增字段类型名称断言） |
| 桌面端浏览器层（真实 Electron 43.8.4） | 最小外壳 + 一次性后端（脚本在会话临时目录，未提交） | 修复前插件文档被 `frame-ancestors` 拒绝；修复后可以加载。不加跳转拦截时外部接收端收到 `/leak?secret=…`，加拦截后没有收到；宿主替换 frame 正常；WebRTC 的 STUN 包两种情况下都能发出 |
| Web 端 CSP 组合（Playwright Chromium） | 同一插件文档分别配“后端 header 加 meta”“只有 meta”“file:// 父页” | header 加 meta：外部导航被拦；只有 meta：外部导航和 WebRTC 都能外发；file:// 父页：修复前被 `frame-ancestors` 拒绝 |
| 编辑器输入延迟 | 无头 Chromium，300 段笔记，每种编辑器每轮 210 次按键，跑两轮 | 开、关编辑器动作没有可测差异（见[性能](#性能)） |
| 无障碍审计 | Playwright 无障碍树快照，加横向滚动、焦点环、对比度和减少动态效果检查 | 见[无障碍](#无障碍) |

## 未验证范围与人工验收清单

- **桌面成品**：完整外壳中的安装、运行、停用恢复、工作台插件卡片、编辑器动作。
- **Android / iOS 真机**：不显示扩展中心入口；编辑器无扩展菜单；工作台不可进入。
- **Docker、NAS、反向代理部署**：页面响应头中的 CSP `frame-src` 是否保留。
- **其他**：真实 AI 模型、真实 Registry 源、屏幕阅读器、远程 CI。
