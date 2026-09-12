<!-- 此文件由 scripts/generate-plugin-host-api.mjs 生成，请勿手动修改。 -->
# Contribution 合同

合同版本：2

运行时键统一为 `<pluginId>/<contributionId>`。声明式 Contribution 由 Host 渲染和执行，不授予任意 React、DOM、CSS 或 Node Runtime。

| 类型 | Since | 声明式 | Runtime | 说明 |
| --- | --- | --- | --- | --- |
| `automationTemplates` | 2.0 | 是 | `declarative`, `sandbox-js`, `node-action` | Static automation templates installed by explicit user action |
| `commands` | 2.0 | 否 | `sandbox-js`, `node-action` | Command palette and host command registrations |
| `menus` | 2.0 | 否 | `sandbox-js`, `node-action` | Host-owned menu placements referencing declared commands |
| `noteTemplates` | 2.1 | 是 | `declarative`, `sandbox-js`, `node-action` | Static note templates rendered/imported by the host |
| `noteThemes` | 2.1 | 是 | `declarative`, `sandbox-js`, `node-action` | Safe note-scoped visual themes rendered by the host without changing app chrome |
| `promptPacks` | 2.1 | 是 | `declarative`, `sandbox-js`, `node-action` | Static prompt packs with explicit variable schemas |
| `settings` | 2.0 | 是 | `declarative`, `sandbox-js`, `node-action` | Host-rendered extension settings |

Note Theme 最大数量：20；Note Template 最大正文：262144 字节；Prompt 最大正文：65536 字节。
