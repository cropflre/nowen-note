# 指定公众号历史采集：阅读会话验证阶段

用户目标是输入某个公众号，获取该公众号已经发布的文章并批量转成笔记。采集目标可以是其他人的公众号，用户无需拥有目标公众号或提供其 AppID / AppSecret。

## 当前实现与未完成项

- 已实现：由任意一篇公开文章识别目标公众号；校验用户本人阅读会话；分页解析主条和多图文次条；选取文章或列表读取结束后分批入队；复用现有正文、图片、去重和失败重试流程。
- 阅读接口为实验验证入口，尚未用有效的真实微信阅读会话通过上线验收。隔离测试中的协议样本只能证明解析、权限、队列逻辑正确，不能证明当前微信接口可用。
- 未实现：仅凭名称搜索目标公众号；自动取得微信阅读会话；扫码授权历史读取；无人值守更新。
- 1.1.0 的公众号 Callback 和扫码绑定属于消息接收入口。它们不提供目标公众号历史文章，现在折叠在辅助入口中。

## 接口来源核对（2026-10-04）

1. [wechat-article-exporter 停止维护说明](https://github.com/wechat-article/wechat-article-exporter/issues/200)报告后台文章列表接口关闭，原来的后台扫码方案无法直接作为当前实现依据。
2. [WeRSS 微信读书说明](https://github.com/rachelos/we-mp-rss/blob/main/docs/weread-mp.md)报告只能取得最新一篇，不能回补历史，不满足“全部历史文章”。
3. [阅读会话协议研究](https://github.com/tingaidehua/wechat-article-downloader-skill/blob/main/docs/protocol-principles.md)及 [Credential 通道源代码](https://github.com/wechat-article/wechat-article-exporter/blob/master/server/api/web/mp/profile_ext_getmsg.get.ts)提供 `mp/profile_ext?action=getmsg` 的候选分页合同。这里实现该候选合同，不把第三方报告当作本机可用性证明。

## 本地验证方式

1. 启用现有微信采集插件，在「指定公众号采集」粘贴目标公众号的一篇公开文章链接。
2. 识别成功后核对公众号名称。将生成的公开主页地址在本人已经登录的微信中打开。
3. 如果用户已经有该页面实际发出的历史请求地址，可在高级验证入口填写；同一请求需要 Cookie 时填写可选字段。不要求用户把这些凭据发给开发者或聊天工具。当前版本没有自动捕获工具，无法取得实际请求时本步骤仍然阻塞。
4. 只有微信返回 `ret=0`、有效 `general_msg_list` 和前进的分页信息才判为验证成功。认证、频控、HTML 验证页、异常 JSON 和跨公众号返回都明确失败。
5. 继续读取每页，确认列表。列表还有下一页时“全部采集”不可用，但可以采集勾选的已读取文章；只有微信返回列表结束后才能分批采集全部已读取文章。

“微信返回结束”仅表示该会话可见列表结束，不能证明已删除、付费或不可见内容也被获取。单次验证保留最多 2000 篇，达到上限时明确报告尚未读完。

## 会话和数据边界

- 授权仅发送到当前 Nowen 后端，再由后端固定请求 `https://mp.weixin.qq.com`。不使用第三方中转；沿用 HTTPS、公共 DNS pinning、超时和响应大小限制。无凭据的公开文章最多允许两次同一白名单主机重定向；携带阅读授权的历史请求禁止重定向。
- 凭据只在进程内保留最多 10 分钟，后端重启、账号 tokenVersion 变化、切换目标或清除会话后须重新验证。它们不写入数据库、插件执行输入、Automation 事件、采集 URL 或响应。
- 会话按 Nowen 用户和目标公众号隔离。批量请求只能选择这个用户已取得的历史文章；提交相同文章的额外查询参数也会替换为目录中的公开 URL。
- 每批最多 20 篇且原子入队；多批失败后，界面保留已经确认入队的计数，再次点击只提交未确认的批次。后台正文采集仍可能失败，结果在收件箱查看。

## 验证

```sh
cd backend
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/wechat-account-history.test.ts tests/wechat-assistant.test.ts
```

Electron 原生 SQLite 环境使用已有 Electron Node 方式。前端运行 `WechatAccountSettings.test.tsx`、`WechatAssistantSettings.test.tsx` 和 API 路径回归。

正式发布下一版本前必须用用户指定的真实公众号验证至少两页、多图文次条、读取结束、正文图片入笔记、再次运行去重和会话过期。上述真实验收未通过前，不将本功能标为“傻瓜式全量采集完成”。
