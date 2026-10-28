# 剪藏图片 Referer 修复验收

- 日期：2026-10-28
- 基线：`release/v1.5.4` / `a0ecc4d7`，加本次未提交修改。
- 来源：[PR #883](https://github.com/cropflre/nowen-note/pull/883)，作者 `umbrellax`，提交 `e7918ae03b9560f6a633762536445ef7b60516e7`。
- 采用其 DNR session 规则补充页面 origin Referer 的方案；重新实现规则隔离、生命周期和失败提示，没有直接合并原提交。

## 行为与边界

- 规则同时限制为当前扩展 origin、非标签页请求（`tabIds: [-1]`）、XHR 和已校验图片域名；域名不包含端口。
- 不同剪藏任务的图片下载阶段串行，避免同一 CDN URL 使用不同 Referer 时串扰；单篇内部保留原有并发。
- 开始下载前替换固定 ID 的 session 规则，结束后在 `finally` 清理。下一任务也清除上次异常遗留的规则。
- API 不可用或规则安装失败时沿用普通下载，不显示“已配置 Referer”。成功配置后仍收到 401/403，只说明配置后仍被拒绝，不推断服务器拒绝原因。
- 沿用 `credentials: omit`、`redirect: error`、`no-referrer`、私网 URL 拦截及数量、大小和超时限制。
- 不变更笔记、附件的持久化、同步或恢复链路，不新增 DCC 契约或迁移。失败保留原图片 URL 的既有行为由新增测试覆盖。

## 自动回归

在 `packages/nowen-clipper` 执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 19/19 通过（新增 9 项） |
| `npm run lint` | `tsc --noEmit` 通过 |
| `npm run build:chrome` | 通过 |
| `npm run build:firefox` | 通过；之后将本地 dist 清单恢复为 Chrome |

新增测试先在原 PR 实现上运行：请求隔离、并发、失败提示和遗留规则清理用例失败；修正后通过。还覆盖缺失 API、无效页面 origin、下载超时、私网地址拦截及异常后队列继续工作。

## Chromium 真实网络验收

环境：Chromium `156.0.8078.4`，独立临时用户目录；加载 Chrome 构建产物的临时副本。仅在副本中增加调用 `localizeRemoteImages` 的测试入口，没有修改正式产物。使用本机 HTTP fixture，并通过 Chromium host resolver 将测试域名映射到回环地址。

1. 任务 A 从 `https://a.example/private?secret=hidden` 下载 CDN 图片，fixture 暂缓其响应。
2. 同时启动任务 B，来源为 `https://b.example/post`，下载相同图片 URL。
3. A 下载期间，普通网页向同一 CDN 发起 `fetch` 和 `<img>` 请求。
4. 释放 A 的响应，等待两个任务完成，并查询 session 规则。

实际结果：

- A 的请求 Referer 为 `https://a.example/`，不含路径或查询参数。
- A 未结束时 B 尚未向 fixture 发出图片请求；随后 B 使用 `https://b.example/`。
- 普通网页的 XHR 和图片请求均保持其自己的 origin Referer。
- 两个任务均成功内联 1 张图片，失败数为 0；最终 session 规则数为 0。

临时执行脚本：`/private/tmp/nowen-pr883-browser-acceptance.mjs`；原始结果：`/private/tmp/nowen-pr883-browser-PdRXNk/acceptance.json`。临时文件不作为长期回归入口。

## 未执行

- 原报告 ctfiot 页面完整剪藏、登录后的 Nowen 服务端导入与保存后重开。
- Firefox / Edge 浏览器运行时、商店打包上传、CI、推送与发布。
