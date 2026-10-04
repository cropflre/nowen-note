# 微信采集助手

1.1.0 提供「连接微信 → 发送文章链接 → 自动保存到微信收件箱」的简化入口。用户无需填写笔记本 ID、标签或 Action 参数；公众号接入由部署管理员配置一次。也可直接在收件箱粘贴一篇或多篇链接，查看进度、打开笔记及重试失败记录。

管理员安装并启用插件后，在「设置 → 插件 → 已安装 → 微信采集助手」展开管理员接入配置，填写公众号凭据和公网 HTTPS 根地址，再将生成的回调地址配置到微信公众平台。扫码要求公众号已开通参数二维码接口。服务与 Nowen 后端一起部署；首版每套 Nowen 服务使用一个公众号，用户身份和收件箱互相隔离。

完整部署、权限和验证步骤见 [微信采集助手部署说明](../../../docs/developer/wechat-assistant.md)。公众号名称采集尚未接入文章目录服务，请发送文章链接。

## 兼容的高级接入方式

原有单用户随机 Webhook、绑定码和文本采集继续保留。下面是该高级方式的配置，不是普通用户使用收件箱的必需步骤。

## 安装与配置

1. 管理员在 Nowen「设置 → 插件 → 市场」开启「允许官方 / 已验证插件使用 Node Runtime」，搜索「微信公众号采集」并安装。插件通过官方 Registry 和 Publisher 双重签名验证；此策略默认关闭，其他企业允许/阻止列表仍然生效。插件不开放独立端口。也可以使用插件 CLI 执行 `pack` 后手动上传，按 Community Node Action 的现有确认流程授权。
2. 授予声明权限并启用。配置「目标笔记本 ID」（须有创建权限）、标签，以及公众号 AppID。
3. 在插件连接中保存微信公众号 `Token`；使用兼容/安全模式时同时保存 43 字符的 `EncodingAESKey`。密钥由 Host 加密存储，插件只调用摘要和 AES-CBC 操作，不能读取密钥原文。
4. 明文消息选择 `plain`；兼容和安全模式选择 `encrypted`。后者拒绝明文 POST，防止降级。
5. 在「入站 Webhook」生成回调地址，立即保存。把地址中的本机域名替换为部署的公网 HTTPS 域名，并确保 `/api/plugin-inbound/` 可被微信访问。将完整地址、相同 Token、消息模式填入微信公众平台服务器配置。
6. 运行「生成绑定码」，在 10 分钟内向公众号发送 `绑定 <绑定码>`。一个回调地址绑定一个 Nowen 用户，当前用户的插件设置、密钥、绑定和执行身份互相隔离。重新生成并使用绑定码可以替换 OpenID；「解除 OpenID 绑定」同时作废未使用的绑定码。
7. 向公众号发送普通文本、一个完整的 HTTPS URL，或者微信 `link` 消息。文本保存为 Markdown；URL 导入文章及图片。网页链接不需要配置任意域名的 `external.fetch` 权限。

在仓库根目录打包：

```sh
cd examples/plugins/wechat-capture
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

回调对已验证消息立即返回 `success`，采集任务先持久化再应答，由现有 Automation Runtime 执行。在自动化中心查看该入站工作流的执行、失败和重试记录。重复投递相同 MsgId 复用同一任务；已保存消息还在用户级插件 storage 中保存回执。采集 Action 不声明可自动重试，避免创建笔记后异常引起重复写入。

## 行为与边界

- 消息签名有效期为 5 分钟；加密消息校验 PKCS#7、报文长度和 AppID，回复也按收到的加密方式生成。
- 未绑定的 OpenID 不能保存笔记，也不会自动绑定到先到达的外部用户。
- 配置界面只能看到自己生成的回调是否存在。完整 URL 只在生成/轮换时显示；轮换或撤销会移除旧地址及待处理任务。用户禁用、tokenVersion 变更、插件禁用或声明变更都会阻断旧地址。
- 仅抓取公开 HTTPS HTML，不执行网页脚本，不绕过登录、验证码或付费限制。正文最多 2MB；提取后最多 512KB；最多本地化 10 张、每张最多 2MB 的图片。失败的图片不阻止正文保存，笔记中不保留远程媒体地址。
- 公众号文章使用已有微信正文提取器，其他网站使用 Mozilla Readability。依赖 JavaScript 生成正文的网页可能无法提取，此时任务会报告失败。
- 收件箱入口处理扫码/关注及取消关注事件。图片/语音/视频消息、公众号菜单配置和主动模板通知不在此版本范围内。
- 单个 URL 入口不等同于登录会话；不要把完整回调 URL 发给其他人。

协议参考：[微信接入概述](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html)、[消息加解密说明](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html)、[被动回复](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Passive_user_reply_message.html)。正文提取：[Mozilla Readability](https://github.com/mozilla/readability)。
