# 5 分钟快速上手 Nowen Note

> 从选择使用方式开始，完成登录、创建笔记本、写下第一篇笔记，并了解数据备份和 AI 配置。

[官方网站](http://nowen.cn/) · [在线体验](http://note.nowen.cn/) · [客户端下载](https://github.com/cropflre/nowen-note/releases) · [教程中心](./README.md)

## 1. 选择使用方式

### Docker Compose（推荐）

适合 NAS、Linux 服务器、软路由和长期自托管。

要求已经安装 Docker Engine 与 Docker Compose v2：

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker compose up -d
```

查看状态：

```bash
docker compose ps
docker compose logs -f --tail=200 nowen-note
```

浏览器打开：

```text
http://<服务器或 NAS 的 IP>:3001
```

> 容器内的持久化目录是 `/app/data`，不是 `/data`。开始长期使用前，请确认容器重启后笔记仍然存在。

### 桌面端或 Android

从 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 下载对应平台安装包：

- Windows / macOS / Linux：Electron 桌面客户端
- Android：APK

客户端首次启动时填写已经部署好的 Nowen Note 服务器地址。手机连接 NAS 时不要填写 `localhost` 或 `127.0.0.1`，应填写 NAS 局域网 IP 或可访问的域名。

### 在线体验

不想立即部署时，可以访问：

- 地址：[http://note.nowen.cn/](http://note.nowen.cn/)
- 账号：`demo`
- 密码：`demo123456`

> 演示账号只用于体验，数据可能被定期重置，请勿存放敏感或重要内容。

### 本地开发

需要 Node.js 20+、npm 和 Git：

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 根目录 Electron、Capacitor 和构建脚本依赖
npm install

# 前后端依赖与原生模块
npm run install:all
```

分别启动两个终端：

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

打开 `http://localhost:5173`。

更多安装方式见[完整部署指南](../deployment.md)。

---

## 2. 首次登录与安全检查

默认管理员账号：

| 字段 | 默认值 |
|---|---|
| 用户名 | `admin` |
| 密码 | `admin123` |

首次登录后立即完成：

1. 打开「设置 → 安全设置」。
2. 修改默认管理员密码。
3. 根据使用场景决定是否开放注册。
4. 公网部署时配置 HTTPS、正确的公开访问地址和允许的 CORS Origin。
5. 创建第一份完整备份。

Docker 首次启动会自动生成并持久化 JWT 密钥。多实例部署时必须手动配置同一个 `JWT_SECRET`。

---

## 3. 认识主界面

桌面端主要由三个区域组成：

1. **左侧导航与文档树**：切换笔记本、收藏、文件、回收站、说说、待办、思维导图、AI 和工作区。
2. **中间笔记列表**：查看当前笔记本中的内容，支持排序、搜索和批量选择。
3. **右侧编辑器**：编辑标题、标签和正文，使用附件、分享、版本历史与 AI 功能。

侧边栏和笔记列表宽度可以拖动调整，也可以收起，让编辑器获得更大空间。移动端使用抽屉式导航，一次聚焦一个主要区域。

---

## 4. 创建第一个笔记本

1. 在左侧「笔记本」区域点击 **＋**。
2. 输入名称，例如「我的笔记」。
3. 选择 Emoji 图标或使用默认图标。
4. 按回车或点击确认。

笔记本可以继续创建子笔记本，并通过拖拽调整顺序和父级关系。

推荐先建立少量稳定的一级分类：

```text
工作
├── 项目
└── 会议

学习
├── 编程
└── 阅读

生活
├── 计划
└── 记录
```

标签适合跨笔记本分类，不需要为了每个主题都创建深层目录。

---

## 5. 创建第一篇笔记

1. 选中刚创建的笔记本。
2. 点击笔记列表中的「新建笔记」。
3. 输入标题和正文。
4. 等待底部保存状态显示完成。

Nowen Note 会自动保存，不需要手动按 `Ctrl/Cmd + S`。

常用管理操作包括：

- 收藏和置顶
- 添加彩色标签
- 移动到其他笔记本
- 锁定避免误编辑
- 创建分享链接
- 查看版本历史
- 移入回收站并恢复

---

## 6. 选择富文本或 Markdown

### 富文本编辑器

适合所见即所得写作，支持：

- 标题、列表、引用、高亮和链接
- 表格、代码块、KaTeX 和 Mermaid
- 图片、视频和普通附件
- 斜杠命令和快捷工具栏

输入 `/` 可以快速插入标题、列表、代码、表格、图片、公式和 AI 指令。

### Markdown 编辑器

适合技术文档和纯文本写作，支持：

- CodeMirror 编辑
- Markdown 实时预览
- 编辑 / 预览分屏和滚动同步
- 代码块语法高亮与自动换行
- 表格、数学公式和 Mermaid

编辑器模式可以在设置或编辑器入口切换。复杂内容切换后建议检查表格、图片和扩展块的显示效果。

---

## 7. 上传图片和附件

可以通过以下方式添加文件：

- 拖拽到编辑器
- 粘贴剪贴板图片
- 使用斜杠命令插入图片
- 点击附件按钮选择文件

文件会进入统一附件系统。系统支持：

- 按 `YYYY/MM` 存储新附件
- 生成多档 WebP 缩略图
- 查看已引用和未引用文件
- 附件健康检查和孤儿清理
- 接入 S3、Cloudflare R2、MinIO 或第三方图床

清理未引用附件前，建议先创建备份。

---

## 8. 配置 AI（可选）

打开「设置 → AI 设置」，选择服务商并填写模型信息。

支持的常见类型：

- OpenAI 及 OpenAI-compatible 接口
- 通义千问
- Google Gemini
- DeepSeek
- 豆包
- Ollama 本地模型

配置完成后可以使用：

- 生成标题和标签
- 总结、续写、改写和翻译
- 批量归类与标签建议
- Embedding 与 RAG 知识问答
- 从笔记生成思维导图

AI 配置按用户保存。输出结果可能存在错误，应用到正式内容前应检查事实、数字、命令和隐私信息。

---

## 9. 创建第一份备份

Docker 部署的核心数据位于 `/app/data`，包括数据库、附件、备份、字体和运行密钥。

建议：

1. 在「设置 → 数据管理」创建完整备份。
2. 确认备份包含数据库和附件。
3. 将 `BACKUP_DIR` 放到独立磁盘或远程存储。
4. 定期进行恢复演练。

只备份 `nowen-note.db` 不能完整恢复图片和附件。

---

## 10. 下一步

- [界面概览](./ui-overview.md)
- [文档树与笔记本](../tree-tutorial.md)
- [富文本编辑器](./editor-rich-text.md)
- [Markdown 编辑器](./editor-markdown.md)
- [标签与收藏](./tags-favorites.md)
- [待办任务中心](./tasks.md)
- [AI 配置](./ai-setup.md)
- [分享与协作](./sharing.md)
- [备份与迁移](./backup-migrate.md)

在线帮助中心：

- [功能与使用教程](http://nowen.cn/docs/nowen-note-features)
- [安装与问题解答](http://nowen.cn/docs/nowen-note-help)
- [API 与开发者文档](http://nowen.cn/docs/nowen-note-api)

> 本教程跟随 `main` 分支和最新稳定 Release 持续更新，不再绑定过期版本号。
