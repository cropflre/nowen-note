# 微信采集助手 1.1

用户要求的「指定公众号历史文章采集」正在单独验证，见[当前实现与验收边界](wechat-account-collection.md)。下述扫码绑定和 Callback 属于辅助消息接收入口，不提供目标公众号历史文章。

## 用户体验

安装后在「设置 → 插件 → 已安装 → 微信采集助手」中直接使用「微信收件箱」。

- 点击「连接微信」，扫描微信接口生成的临时二维码并关注公众号。
- 向公众号发送一篇或多篇 HTTPS 文章链接，一次最多 20 篇。链接可以混在文字中。
- 首次采集自动在该用户个人空间创建「微信收件箱」，无需笔记本 ID、标签或 Action 参数。
- 回调完成校验后先持久化任务再应答，文章在现有 Automation Runtime 后台采集。
- 在收件箱查看每篇文章的排队、完成、失败状态；打开生成的笔记或重试失败记录。
- 没有公众号时，也可以在同一界面粘贴文章链接，验证本地完整采集流程。

公众号名称采集还没有接入文章目录服务，目前会明确提示发送文章链接；不承诺获取公众号全部历史文章。不同短链和长链之间未做远程解析去重。包含 `__biz / mid / idx` 的微信文章链接按这三个字段去重，其他链接按去除 fragment、排序 query 后的 HTTPS URL 去重。已进入回收站的笔记允许重新采集。

## 部署管理员一次性配置

服务随 Nowen 后端一起部署，不另开监听端口。首版为 **一套 Nowen 服务连接一个公众号**，这套服务中的用户共享公众号接入，笔记和微信绑定按用户隔离。尚未提供跨多个私有实例的公共中转服务。

1. 部署包含此功能的 Nowen 服务，持久化整个 data 目录，包括数据库、附件和 `.plugin_secret_key`。通过公网 HTTPS 根域名访问，反向代理 `/api/` 到 Nowen 后端，保留查询参数及原始 XML 请求体。
2. 安装微信采集助手 1.1.0 或更新版本，按现有插件策略确认 Node Runtime、授予声明权限并启用。安装或配置助手不会自动打开企业 Node Runtime 策略。
3. 公众号须能调用带参数二维码接口。先在微信公众平台核对该账号的接口权限、服务器 IP 白名单及消息服务器配置。缺少接口权限时，界面显示微信返回的错误码，不生成虚假的可用二维码。
4. 展开助手的「管理员接入配置」，填写公网 HTTPS 根地址、AppID、Token、AppSecret、EncodingAESKey。推荐安全或兼容模式；明文模式只用于明确配置为明文的公众号。
5. 保存后，将界面显示的 `https://你的域名/api/wechat-assistant/callback`、相同 Token、EncodingAESKey 和消息模式填到微信公众平台，完成服务器验证。
6. 普通用户点击连接并扫码即可。已有凭据留空表示保留；切换公众号会断开旧微信绑定并作废旧二维码。

Token、AppSecret、EncodingAESKey 使用已有 PluginSecrets 加密存储，不出现在配置查询响应中。AppSecret 仅用于后端固定微信 API 主机的凭据及二维码请求；签名、XML、AES 校验与回复在插件内完成。回调路径跳过访问日志，避免查询签名和验证 challenge 被记录。外部 API 使用 HTTPS、固定主机白名单、DNS pinning、无重定向和响应大小限制。

二维码生成和真实公众号扫码还须用实际公众号做上线验收。本地回归模拟微信 API 响应，但使用真实插件执行器、签名/AES 回调、数据库队列和笔记业务链路；模拟接口通过不能代替微信平台授权验收。

## 隔离与队列

- 二维码 scene 使用随机 128-bit 值，数据库仅存 SHA-256；10 分钟有效，一次性消费，同一微信不能同时绑定两个用户。
- 回调身份来自已验证消息的 OpenID，忽略请求中的用户/Authorization Header；普通用户只查询自己的记录和重试自己的任务。
- 重复微信 MsgId 与相同文章链接均复用采集项。重试保留原采集项和插件回执，避免重复创建已确认成功的笔记。
- 每项保存提交时的 tokenVersion，运行前复核；账号禁用、授权撤销、插件禁用阻断旧队列。断开连接/取消关注取消尚未开始的微信任务，已经开始的任务可能完成。
- 本地粘贴不依赖微信接入配置；微信后台任务额外复核接入管理员授权。
- 收件箱只展示最近 100 条。通用自动化中心仍保留实际 Workflow Run 和 Step 的详情。

## 验证

使用项目 backend 隔离数据库预加载脚本运行：

```sh
cd backend
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/wechat-assistant.test.ts tests/wechat-capture.test.ts tests/article-import.test.ts
```

Electron 原生模块环境须用项目已有 Electron Node 运行方式，避免切换 SQLite ABI 影响运行中的 Web 服务。

协议参考：[参数二维码](https://developers.weixin.qq.com/doc/offiaccount/Account_Management/Generating_a_Parametric_QR_Code.html)、[事件推送](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_event_pushes.html)、[access_token](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html)。
