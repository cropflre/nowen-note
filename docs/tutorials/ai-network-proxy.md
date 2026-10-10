# AI 服务出站代理（#815）

Nowen Note 的 AI 模型请求由 Nowen Server 发出。Windows、Android 或浏览器自己连接代理，并不一定能改变 Docker 容器中的网络出口。

v1.5.2 新增可选的**服务端 AI 出站代理**，作用于 AI 对话与流式输出、模型发现、连通性测试和 Embedding 检索索引，不影响普通笔记同步、附件和备份。默认直连。全部客户端共用服务端配置。

## Docker Compose

在 nowen-note 服务的 environment 下配置如下变量；服务名请以实际的 compose 文件为准：

```yaml
services:
  nowen-note:
    environment:
      NOWEN_AI_PROXY_URL: "http://host.docker.internal:7890"
      NOWEN_AI_NO_PROXY: "ollama,llm.internal"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

修改后重建/重启后端容器，在 设置 → AI 配置 查看「AI 网络代理」状态，然后尝试「刷新模型」和「测试连接」。

### 配置说明

- `NOWEN_AI_PROXY_URL`：HTTP 或 HTTPS 代理的完整 URL，例如 `http://host.docker.internal:7890`。不支持直接填写 `socks5://`；使用 SOCKS5 代理时，请在代理软件开放 HTTP 代理入口。
- `NOWEN_AI_NO_PROXY`：额外的直连主机，逗号分隔；精确域名和 `.example.org` 后缀匹配。默认绕过 localhost、127.0.0.1、host.docker.internal 以及常见本地网段，保护本地 Ollama 和 LM Studio 请求。
- 默认不启用。无配置时继续使用现有 Node fetch 直连，不覆盖 Node 全局网络设置。
- 支持 HTTP 代理认证（`http://user:password@proxy-host:port`），请对密码特殊字符做 URL 编码，并使用受保护的环境变量注入真实凭据。不要提交含凭据的 Compose 文件。

注意：Docker 内部的 `127.0.0.1` 是容器自身，通常不是宿主机代理。Linux Docker 可能需要上例 `extra_hosts`；宿主机代理必须能接受来自 Docker 网桥的连接并做好防火墙限制。代理是否能访问实际 AI 服务商仍须测试。

代理属于管理员侧全局网络出口设置，并非普通用户可以指定的任意出站主机。状态接口只返回是否启用、配置是否有效及说明，不返回代理 URL 或其凭据。
