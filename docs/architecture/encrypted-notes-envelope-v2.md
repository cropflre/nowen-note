# Encrypted Content v2（内部实现，待产品接入和独立复核）

v1 格式及 AAD 保持兼容。v2 不是正式开放声明；当前 Native 和普通 API 不接受其正文写入，只有内部转换/存储测试使用。

## 身份与密钥

外层为固定 12 字段：`version:2`、`algorithm:"AES-256-GCM"`、`objectId`、`kind`、`originalFormat`、`parentObjectId`、`documentSchemaVersion:1`、`keyEpoch`、`encryptionEpoch`、`kdf`、`wrappedKey`、`payload`。UUID 使用小写 v4；epoch 是正的 JavaScript 安全整数。整篇 parent 为 null，局部 parent 为所属整篇对象的 UUID。

Argon2id v19 使用 65536 KiB / 3 iterations / 4 lanes / 16 字节随机 salt；派生 KEK 包装 32 字节随机根密钥。会话内根密钥为非导出的 AES CryptoKey。改密码仅换 salt/KEK/包装，不改变根密钥或 keyEpoch。不同密码下的旧包装依然能用旧密码打开。

所有 AAD 是 UTF-8 编码的固定位置 JSON 数组：

```text
["nowen-encrypted-content",2,"AES-256-GCM",purpose,
 objectId,kind,originalFormat,parentObjectId,documentSchemaVersion,
 keyEpoch,encryptionEpoch,...context]
```

用途分别为 `root-key`、`document`、`history`、`file-key`、`file-chunk`。根包装、正文、历史和文件包装使用独立随机 12 字节 IV。正文密文的 plaintext 是 `{documentSchemaVersion:1,content:string,attachments:manifest[]}`，最多 4 MiB UTF-8，附件清单及名字/MIME 只存在此受认证正文内。

## 历史

独立 `encrypted-history-v2` 记录为 `{version:1,objectId,keyEpoch,encryptionEpoch,historyId,sourceVersion,originalFormat,payload}`。payload 由笔记根密钥加密；AAD 的 context 为 `[1,historyId,sourceVersion,originalFormat]`，防止版本和格式调包。

历史 plaintext 为 `{document:{documentSchemaVersion:1,content,attachments},changeSummary:string|null}`。服务器保留原 historyId、version、title、userId、createdAt、changeType，清空明文 contentText/changeSummary。客户端读回核验正文和说明；服务端只能校验结构、来源摘要及映射。

内部转换要求完整历史集合；每条来源摘要为 SHA-256(UTF-8(JSON.stringify([content,contentFormat,version,changeSummary])))，当前正文摘要沿用 SHA-256(content)。历史追加、删除或来源改变使整个事务拒绝；显式 `discardHistory:true` 与 encryptedHistory 互斥。该原语只处理文本、无同步 Profile 场景；不能据此开放完整迁移。

## 附件

每次上传产生新 attachmentId/uploadId、随机 32 字节文件密钥及 8 字节 nonce 前缀。文件密钥由根密钥包装，context 为 `[1,attachmentId,uploadId]`。文件块为 1 MiB；nonce 是前缀 + uint32 big-endian 块序号，AAD context 为 `[1,attachmentId,uploadId,index]`。

空文件使用一块空正文的 GCM 密文（16 字节 tag）。codec 单文件上限 100 MiB；服务端更低的上传政策仍需在接入时协商。重试只能复用已生成的密文；再次调用 codec 创建独立 uploadId 和文件密钥。

manifest 固定字段为 `{version:1,attachmentId,uploadId,noncePrefix,name,mime,size,wrappedKey,chunks}`。chunks 有序记录 `{index,ciphertextBytes,sha256}`，数量和尺寸必须与 size 对应。SHA-256 仅用于传输校验，GCM 和受认证的完整 manifest 才提供认证。解密流的明文块在推进或关闭迭代器后清零，消费方需先复制/消费当前块。不同文件、上传、父对象、epoch 或序号无法互换。

未接入普通附件路由；当前 codec 测试不代表上传原子性、离线缓存、跨设备或备份已完成。格式发布前仍需独立密码学设计复核。
