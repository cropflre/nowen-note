# Community Registry V1

Registry 是可镜像的开放 JSON 协议，不绑定 GitHub Raw。管理员可在插件中心配置 HTTPS 镜像或自建来源。

```json
{
  "plugins": [{
    "id": "com.example.ai-tools",
    "name": "AI Tools",
    "latestVersion": "1.2.0",
    "trustLevel": "community",
    "versions": [{
      "version": "1.2.0",
      "download": "https://example.com/ai-tools-1.2.0.nowen-plugin",
      "sha256": "64-character lowercase hex",
      "nowen": ">=1.5.0 <2.0.0"
    }]
  }]
}
```

安装流程会校验 Registry Schema、Nowen 兼容范围、20MB 下载预算、SHA256、包内 Manifest 身份以及流式 ZIP 安全限制。

信任等级只有 `official`、`verified`、`community`、`developer`。Verified 代表审核状态，不代表 Node Runtime 已成为安全沙箱。
