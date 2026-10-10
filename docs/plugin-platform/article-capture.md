# 网页采集 Host API

```ts
const note = await nowen.capture.importUrl({
  url: "https://example.com/article",
  notebookId: "accessible-notebook-id",
  tags: ["稍后阅读"],
  comment: "为什么收藏这篇文章"
});
// { id, title, imagesImported, imagesSkipped }
```

需要用户明确授予 `capture:write`。Host 在请求网络前检查目标笔记本的写入 ACL，再通过 canonical Note / Tag 命令网关保存，保留知识树、版本和同步等现有副作用。调用者不能通过参数指定 userId。标签在目标笔记本所属空间创建和关联。

抓取复用 Registry 的公网 HTTPS transport：拒绝凭证和私有/保留地址，每次重定向重验 DNS，socket 固定到本次验证的公网 IP；采集不启用 Registry 透明代理 DNS 例外。HTML 最多 2MB，Readability 不加载 DOM 资源、不执行脚本，输出统一 HTML 清洗。网页总抓取预算 10 秒，图片并行各 3 秒；最多 10 张图片，每张 2MB，使用同款安全 transport、魔数检测及现有附件存储。失败图片被移除并计入 imagesSkipped，正文继续保存。

URL 必须是公开 HTTPS HTML；此 API 不授予通用网络请求能力。`external.fetch` 仍要求明确域名白名单，禁止 `*`。
