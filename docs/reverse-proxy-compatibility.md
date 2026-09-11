# 反向代理兼容与 App 连接

Nowen Note v1.5.0 起会在客户端连接服务器时自动检测常见的反向代理路径改写。对 Lucky、飞牛、群晖、宝塔、Nginx Proxy Manager 等场景，通常只需要把浏览器中能够访问 Nowen Note 的地址填写到 App，不需要手工在地址后追加 `/api`、`/public` 或 `/ws`。

## 自动探测范围

客户端始终优先使用标准路径，并且只在用户输入的同一协议、域名/IP、端口和反向代理前缀下尝试兼容路径：

```text
API
/api/health
/public/api/health
/publicapi/health

WebSocket
/ws
/public/ws
/publicws
```

例如用户填写：

```text
https://notes.example.com/nowen
```

客户端只会在 `https://notes.example.com/nowen` 下探测对应 API，并使用 `wss://notes.example.com/nowen` 下的 WebSocket 候选；不会跳转到其它主机，也不会把 HTTPS 降级成 HTTP。

探测成功后，Nowen Note 会缓存当前服务器实际可用的 API / WebSocket 路径。多服务器场景会按服务器地址分别保存，不会因为切换服务器而互相覆盖。

## Lucky `proxy_pass .../public` 场景

部分 Lucky 自动生成的配置类似：

```nginx
location / {
    proxy_pass http://192.168.31.1:3001/public;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

这种配置可能把外部 `/api/...`、`/ws` 改写成上游的 `/publicapi/...`、`/publicws`，或者 `/public/api/...`、`/public/ws`。v1.5.0 的服务端只对这些明确的兼容前缀做窄范围映射，并继续进入原有 API JWT / ACL 和 WebSocket token 校验流程。

因此，如果网页可以打开，建议先直接把同一个网页地址填写到 App，让客户端自动探测，不要先手工拼接 `/public`。

## 连接诊断

测试服务器地址时，客户端会分别判断：

```text
API 正常 / WebSocket 正常
API 正常 / WebSocket 异常
API 异常
```

健康检查不仅判断 HTTP 200，还会校验返回内容是否为 Nowen Note API JSON。NAS 门户、登录页或其它 HTML 200 页面不会被当成连接成功。

如果检测到 `/public` 路径改写，登录页会提示已启用反向代理兼容，并显示实际检测到的 API / WebSocket 路径。

## 自动探测仍失败时

优先检查：

1. 反向代理是否允许 WebSocket Upgrade；
2. HTTPS 证书是否被设备信任；
3. 反向代理是否把 API 转发到 Nowen Note 后端端口；
4. 防火墙、NAS 安全策略是否允许 App 所在网络访问；
5. 自定义 CORS 配置是否允许对应网页/客户端来源。

推荐的标准 Nginx 配置仍然是直接代理到 Nowen Note 根路径：

```nginx
location / {
    proxy_pass http://192.168.31.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

如果现有 Lucky 自动配置已经能被 Nowen Note 自动兼容，则无需为了 App 单独修改代理。

## 安全说明

反向代理兼容只改变路径解析，不会：

- 放宽登录认证；
- 绕过工作区/资源 ACL；
- 取消 WebSocket token 校验；
- 自动信任其它域名；
- 将 HTTPS 静默降级为 HTTP；
- 把任意 404 路径自动映射到 API。

兼容规则仅覆盖 `/public/api/*`、`/publicapi/*` 以及对应的 WebSocket 路径。标准 `/api`、`/ws` 始终拥有最高优先级。
