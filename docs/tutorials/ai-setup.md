# 如何配置 AI 服务商

> 让 AI 成为你的写作助手、笔记总结员和知识管理员。

---

## 支持的 AI 服务商

nowen-note 支持以下 AI 服务商和接口：

| 服务商 | 模型示例 | 需要 API Key | 国内访问 |
|---|---|---|---|
| 通义千问 | qwen-plus / qwen-max | ✅ | ✅ 直连 |
| OpenAI | GPT-4o / GPT-4 | ✅ | ⚠️ 需代理 |
| Anthropic Messages（原生协议） | 服务端提供的 Claude 模型 | ✅ 或自定义鉴权头 | 按部署网络配置 |
| Google Gemini（OpenAI 兼容协议） | 服务端提供的 Gemini 模型 | ✅ | ⚠️ 需代理 |
| DeepSeek | DeepSeek-V3 / R1 | ✅ | ✅ 直连 |
| 豆包（火山引擎） | doubao-pro | ✅ | ✅ 直连 |
| Ollama | 各种开源模型 | ❌ 本地运行 | ✅ 无需网络 |
| LM Studio | 本地或局域网模型 | ❌ | 按部署网络配置 |
| 自定义 API | OpenAI 兼容模型 | ✅ 或自定义鉴权头 | 按部署网络配置 |

---

## 配置步骤

### 步骤一：打开 AI 设置

1. 点击左侧导航栏的 ⚙️ 设置图标
2. 在设置面板中选择「AI 设置」

[截图：设置面板中的 AI 设置入口]

### 步骤二：选择服务商

1. 在「AI 服务商」下拉框中选择服务商
2. 系统会自动填入默认的 API 地址

[截图：服务商选择下拉框]

### 步骤三：填写 API Key

1. 在对应服务商的控制台获取 API Key
2. 将 API Key 粘贴到对应输入框
3. API Key 按用户保存在 Nowen Note 服务端数据库中，调用时发送给所配置的 AI 服务；配置接口只返回掩码。

[截图：API Key 输入框]

### 步骤四：选择模型

1. 填入 API Key 后，系统自动加载可用模型列表
2. 从下拉框中选择模型

[截图：模型选择下拉框]

### 步骤五：测试连接

1. 点击「测试连接」按钮
2. 看到「连接成功」即可使用

---

## 各服务商配置指南

### 通义千问（推荐国内用户）

1. 访问 [阿里云百炼平台](https://bailian.console.aliyun.com/)
2. 在「API-KEY 管理」中创建 API Key
3. 在 nowen-note 中选择「通义千问」，粘贴 Key
4. 推荐模型：`qwen-plus`（性价比高）

### OpenAI

1. 访问 [OpenAI Platform](https://platform.openai.com/)
2. 在 API Keys 中创建 Key
3. 在 nowen-note 中选择「OpenAI」，粘贴 Key
4. 推荐模型：`gpt-4o`

> ⚠️ 国内需要代理。可在「API 地址」中填入代理地址。

### DeepSeek

1. 访问 [DeepSeek Platform](https://platform.deepseek.com/)
2. 创建 API Key
3. 推荐模型：`deepseek-chat`（即 V3）

### 豆包（火山引擎）

1. 访问 [火山引擎控制台](https://console.volcengine.com/)
2. 开通豆包大模型服务，创建 API Key

### Google Gemini

1. 访问 [Google AI Studio](https://aistudio.google.com/)
2. 获取 API Key
3. 地址可自定义，默认是 `https://generativelanguage.googleapis.com/v1beta/openai`。此选项使用 OpenAI 兼容协议，不支持直接填写 Gemini 原生 `models/*:generateContent` 地址。

### Anthropic Messages 与自建网关

1. 选择「Anthropic」，基础地址默认是 `https://api.anthropic.com/v1`，也可填写网关地址，例如 `https://gateway.example/anthropic/v1`。
2. 系统自动追加 `/messages`；不要把完整 `/messages` 地址填入基础地址。OpenAI 兼容配置则自动追加 `/chat/completions`。
3. 填写 API Key 和网关实际提供的模型名称。Anthropic 配置默认发送 `x-api-key` 与 `anthropic-version: 2023-06-01`；不同版本要求可在自定义请求头中覆盖。
4. 展开「高级：自定义请求头」，逐项填写名称和值，例如 `x-session`。每份配置独立保存，切换配置时一并切换；仅使用自定义鉴权头的网关可将 API Key 留空。
5. 点击「保存并测试」。网关未提供 `/models` 时，可手动输入模型名称后测试；模型列表加载失败不代表聊天接口不可用。

自定义请求头应用于连接测试、模型发现、聊天、写作助手及文档处理。头名称不区分大小写，同名自定义头覆盖默认鉴权头；`Content-Type`、`Host`、`Content-Length` 等传输头由系统管理。最多 32 项，总长度不超过 16 KB，禁止换行。

头值按凭据处理，保存后只显示掩码；修改配置时保留掩码可继续使用原值，重命名请求头后须重新输入值，删除行会移除该头。服务请求不跟随重定向，以免网关凭据被转发到其他地址。

向量检索复用 OpenAI 兼容的聊天配置或绑定配置时，会使用该配置的请求头；单独填写的向量服务地址不会继承聊天配置的请求头。Anthropic Messages 不提供向量接口，需要另选 OpenAI 兼容的 Embedding 配置。AI Agent 的工具调用当前仍要求 OpenAI 兼容协议，支持使用该配置的自定义请求头；Anthropic 原生配置可用于文本功能，暂不支持 Agent 工具调用。本次不支持 Responses API 或 Gemini 原生协议，仅修改路径不能切换协议。

### Ollama（本地部署，无需 API Key）

Ollama 在本地电脑上运行 AI 模型，不需要联网。

**安装：**

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows：从 https://ollama.com/download 下载安装包
```

**下载模型：**

```bash
ollama pull qwen2.5:7b    # 推荐，约 4GB
ollama pull qwen2.5:3b    # 更轻量，约 2GB
ollama pull qwen2.5:14b   # 更强，约 13GB
```

**配置：**

1. 确保 Ollama 正在运行
2. 在 AI 设置中选择「Custom / Ollama」
3. API 地址：`http://localhost:11434/v1`
4. 无需 API Key，选择模型即可

---

## AI 功能一览

配置好 AI 后可以使用以下功能：

### 编辑器中的 AI

| 功能 | 入口 | 说明 |
|---|---|---|
| 生成标题 | 工具栏 → AI → 生成标题 | 根据内容自动生成 |
| 推荐标签 | 工具栏 → AI → 推荐标签 | 分析内容推荐标签 |
| AI 总结 | 工具栏 → AI → AI 总结 | 生成内容摘要 |
| 写作助手 | 输入 `/AI` 或工具栏 AI 图标 | 续写、改写、翻译 |

### 笔记列表中的 AI 批量操作

| 功能 | 入口 | 说明 |
|---|---|---|
| 批量 AI 标签 | 多选笔记 → 右键 → AI 标签 | 为多篇笔记生成标签 |
| AI 批量归类 | 多选笔记 → 右键 → AI 归类 | AI 建议移动到哪个笔记本 |

### AI 知识库问答

| 功能 | 入口 | 说明 |
|---|---|---|
| AI 问答 | 左侧导航栏「AI 问答」 | 基于笔记内容的 RAG 问答 |

---

## 常见问题

### Q：配置了 AI 但没有生效？

1. 确认 API Key 填写正确
2. 点击「测试连接」检查连通性
3. 检查网络（国内推荐通义千问或 DeepSeek）

### Q：Ollama 启动后还是不工作？

1. 确认 Ollama 正在运行（终端执行 `ollama list`）
2. 确认 API 地址正确（`http://localhost:11434/v1`）
3. 确认已下载模型（`ollama pull qwen2.5:7b`）

### Q：AI 回复很慢？

- 本地 Ollama 速度取决于电脑性能
- 云端 API 速度取决于网络
- 推荐用较小模型获得更快响应

### Q：API Key 安全吗？

API Key 和自定义请求头按用户保存在 Nowen Note 服务端数据库中，调用时发送给所配置的 AI 服务，配置接口返回掩码。请只配置可信的服务地址，并保护服务器数据库及备份。

---

> Anthropic Messages 和自定义请求头的使用方式以包含 Issue #885 改动的版本为准。
