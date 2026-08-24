# Extension Ecosystem V2 RC1 发布门禁

Extension Ecosystem V2 的 Official Registry 使用随 Nowen 发布包编译的 Ed25519 **公钥**作为信任锚。私钥不得进入 Nowen 仓库、安装包、Docker 镜像或客户端配置。

## 源码默认状态

`backend/src/plugins/official-registry-trust-roots.json` 在开发源码中可以保持 `[]`。此状态下 Official Registry 会 fail closed，Custom Registry 仍必须由管理员显式 pin Ed25519 公钥。

正式发布标签不允许空根：`.github/workflows/extension-ecosystem-rc1-ci.yml` 会执行 RC1 release gate，根为空、格式无效、已过期或 Host API 生成物漂移都会失败。

## 生成生产信任根

发布前准备一个仅包含公开信息的 JSON，例如：

```json
[
  {
    "sourceId": "official-v2",
    "sourceName": "Nowen Official Registry",
    "indexUrl": "https://extensions.example.com/v2/index.json",
    "keyId": "root-2026",
    "algorithm": "Ed25519",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "sequence": 1,
    "state": "active",
    "validFrom": "2026-08-01T00:00:00.000Z",
    "validUntil": "2028-08-01T00:00:00.000Z"
  }
]
```

然后执行：

```bash
node scripts/generate-official-registry-trust-roots.mjs \
  --input /secure/release/official-registry-roots.json

node scripts/verify-extension-ecosystem-rc1.mjs
```

也可用 `NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_FILE` 指定输入文件。生成器会拒绝：

- 私钥或非 Ed25519 公钥；
- HTTP、带凭证或带 fragment 的 Registry URL；
- 重复 source/key 坐标；
- 同一 source 没有 active 根或存在多个 active 根；
- 无效 sequence 和有效期。

生产公钥本身不是 Secret，可以随发布源码/构建产物公开；**Registry/Publisher 私钥必须只保存在离线签名环境或受保护 CI Secret 中。**

## 根轮换

正式客户端从编译根建立信任。后续 Root Rotation 必须由当前 active root 的私钥签名，客户端会验证 `parentKeyId`、`sequence`、有效期和 Ed25519 签名，并持久化受信链。不得通过管理 API 或 Registry 响应直接覆盖 Official Root。

## RC1 安全回归

专项 CI 覆盖：

- QuickJS 中 Node/browser 高权限全局变量与 Function constructor 逃逸面不可用；
- Host API 调用预算和既有 Sandbox 限制；
- localhost、Metadata IP、IPv6 loopback、IPv4-mapped IPv6、URL credential/fragment SSRF 输入；
- Registry metadata sequence rollback、equivocation、generatedAt 时间回退；
- 未编译可信根的未知 Official Registry 必须 fail closed；
- Host API 合同生成物必须与 SDK/Backend/文档同步。

发布 RC 不应通过降低这些门禁来兼容错误插件或错误 Registry；遇到不兼容应修复插件包、Registry 元数据或签名链本身。
