/**
 * Nowen Note OpenAPI 规范自动生成
 *
 * 从路由定义自动生成 OpenAPI 3.0 JSON，
 * 提供 /api/openapi.json 端点供 Swagger UI 等工具消费。
 */

export function generateOpenAPISpec(): Record<string, any> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Nowen Note API",
      version: "1.0.0",
      description: "Nowen Note 笔记系统完整 REST API 文档",
      contact: { name: "Nowen Note" },
    },
    servers: [
      { url: "http://localhost:3001", description: "本地开发" },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Notebook: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            icon: { type: "string" },
            color: { type: "string" },
            parentId: { type: "string", nullable: true },
            noteCount: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Note: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            notebookId: { type: "string" },
            title: { type: "string" },
            content: { type: "string", description: "Tiptap JSON 内容" },
            contentText: { type: "string", description: "纯文本内容" },
            isPinned: { type: "integer", enum: [0, 1] },
            isFavorite: { type: "integer", enum: [0, 1] },
            isLocked: { type: "integer", enum: [0, 1] },
            isTrashed: { type: "integer", enum: [0, 1] },
            version: { type: "integer" },
            tags: { type: "array", items: { $ref: "#/components/schemas/Tag" } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Tag: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            color: { type: "string" },
            noteCount: { type: "integer" },
          },
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            isCompleted: { type: "integer", enum: [0, 1] },
            priority: { type: "integer", description: "1=高 2=中 3=低" },
            dueDate: { type: "string", nullable: true },
            noteId: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        MindMap: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            data: { type: "string", description: "JSON 格式的导图数据" },
            noteId: { type: "string", nullable: true },
          },
        },
        Plugin: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            description: { type: "string" },
            author: { type: "string" },
            status: { type: "string", enum: ["active", "error", "disabled"] },
            capabilities: { type: "array", items: { type: "object" } },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            id: { type: "string" },
            url: { type: "string", format: "uri" },
            events: { type: "array", items: { type: "string" } },
            isActive: { type: "integer" },
            description: { type: "string" },
          },
        },
        AuditLog: {
          type: "object",
          properties: {
            id: { type: "string" },
            userId: { type: "string" },
            category: { type: "string" },
            action: { type: "string" },
            level: { type: "string", enum: ["info", "warn", "error"] },
            targetType: { type: "string" },
            targetId: { type: "string" },
            details: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        BackupInfo: {
          type: "object",
          properties: {
            id: { type: "string" },
            filename: { type: "string" },
            size: { type: "integer" },
            type: { type: "string", enum: ["full", "db-only"] },
            noteCount: { type: "integer" },
            notebookCount: { type: "integer" },
            checksum: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      // ===== 认证 =====
      "/api/auth/login": {
        post: {
          tags: ["认证"],
          summary: "用户登录",
          security: [],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } }, required: ["username", "password"] } } } },
          responses: { "200": { description: "登录成功，返回 JWT Token" } },
        },
      },
      "/api/auth/verify": {
        get: { tags: ["认证"], summary: "验证 Token", responses: { "200": { description: "Token 有效" } } },
      },
      "/api/auth/change-password": {
        post: { tags: ["认证"], summary: "修改密码", requestBody: { content: { "application/json": { schema: { type: "object", properties: { oldPassword: { type: "string" }, newPassword: { type: "string" } } } } } }, responses: { "200": { description: "密码修改成功" } } },
      },

      // ===== 笔记本 =====
      "/api/notebooks": {
        get: { tags: ["笔记本"], summary: "获取笔记本列表（树形结构）", responses: { "200": { description: "笔记本列表", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Notebook" } } } } } } },
        post: { tags: ["笔记本"], summary: "创建笔记本", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, parentId: { type: "string" }, icon: { type: "string" }, color: { type: "string" } }, required: ["name"] } } } }, responses: { "201": { description: "创建成功" } } },
      },
      "/api/notebooks/{id}": {
        put: { tags: ["笔记本"], summary: "更新笔记本", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "更新成功" } } },
        delete: { tags: ["笔记本"], summary: "删除笔记本", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "删除成功" } } },
      },

      // ===== 笔记 =====
      "/api/notes": {
        get: { tags: ["笔记"], summary: "获取笔记列表", parameters: [{ name: "notebookId", in: "query", schema: { type: "string" } }, { name: "isFavorite", in: "query", schema: { type: "string" } }, { name: "isTrashed", in: "query", schema: { type: "string" } }, { name: "search", in: "query", schema: { type: "string" } }], responses: { "200": { description: "笔记列表" } } },
        post: { tags: ["笔记"], summary: "创建笔记", requestBody: { content: { "application/json": { schema: { type: "object", properties: { notebookId: { type: "string" }, title: { type: "string" }, content: { type: "string" }, contentText: { type: "string" } }, required: ["notebookId"] } } } }, responses: { "201": { description: "创建成功" } } },
      },
      "/api/notes/{id}": {
        get: { tags: ["笔记"], summary: "获取笔记详情", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "笔记详情", content: { "application/json": { schema: { $ref: "#/components/schemas/Note" } } } } } },
        put: { tags: ["笔记"], summary: "更新笔记", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "更新成功" } } },
        delete: { tags: ["笔记"], summary: "永久删除笔记", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "删除成功" } } },
      },

      // ===== 标签 =====
      "/api/tags": {
        get: { tags: ["标签"], summary: "获取标签列表", responses: { "200": { description: "标签列表" } } },
        post: { tags: ["标签"], summary: "创建标签", responses: { "201": { description: "创建成功" } } },
      },

      // ===== 任务 =====
      "/api/tasks": {
        get: { tags: ["任务"], summary: "获取任务列表", responses: { "200": { description: "任务列表" } } },
        post: { tags: ["任务"], summary: "创建任务", responses: { "201": { description: "创建成功" } } },
      },
      "/api/tasks/stats/summary": {
        get: { tags: ["任务"], summary: "任务统计", responses: { "200": { description: "统计数据" } } },
      },
      "/api/tasks/{id}/toggle": {
        patch: { tags: ["任务"], summary: "切换任务完成状态", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "状态已切换" } } },
      },

      // ===== 思维导图 =====
      "/api/mindmaps": {
        get: { tags: ["思维导图"], summary: "获取导图列表", responses: { "200": { description: "导图列表" } } },
        post: { tags: ["思维导图"], summary: "创建导图", responses: { "201": { description: "创建成功" } } },
      },

      // ===== 搜索 =====
      "/api/search": {
        get: { tags: ["搜索"], summary: "全文搜索笔记", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "搜索结果" } } },
      },

      // ===== AI =====
      "/api/ai/chat": {
        post: { tags: ["AI"], summary: "AI 写作助手（SSE 流式）", requestBody: { content: { "application/json": { schema: { type: "object", properties: { action: { type: "string" }, text: { type: "string" }, customPrompt: { type: "string" } } } } } }, responses: { "200": { description: "SSE 流式响应" } } },
      },
      "/api/ai/ask": {
        post: { tags: ["AI"], summary: "知识库问答（SSE 流式）", requestBody: { content: { "application/json": { schema: { type: "object", properties: { question: { type: "string" } } } } } }, responses: { "200": { description: "SSE 流式响应" } } },
      },
      "/api/ai/settings": {
        get: { tags: ["AI"], summary: "获取 AI 设置", responses: { "200": { description: "AI 配置" } } },
        put: { tags: ["AI"], summary: "更新 AI 设置", responses: { "200": { description: "更新成功" } } },
      },
      "/api/ai/models": {
        get: { tags: ["AI"], summary: "获取可用模型列表", responses: { "200": { description: "模型列表" } } },
      },
      "/api/ai/knowledge-stats": {
        get: { tags: ["AI"], summary: "知识库统计", responses: { "200": { description: "统计数据" } } },
      },

      // ===== 插件 =====
      "/api/plugins": {
        get: { tags: ["插件"], summary: "获取已加载插件列表", responses: { "200": { description: "插件列表", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Plugin" } } } } } } },
      },
      "/api/plugins/reload": {
        post: { tags: ["插件"], summary: "重新扫描加载插件", responses: { "200": { description: "加载结果" } } },
      },
      "/api/plugins/{name}/execute": {
        post: { tags: ["插件"], summary: "执行指定插件", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "执行结果" } } },
      },

      // ===== Webhook =====
      "/api/webhooks": {
        get: { tags: ["Webhook"], summary: "获取 Webhook 列表", responses: { "200": { description: "Webhook 列表", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Webhook" } } } } } } },
        post: { tags: ["Webhook"], summary: "创建 Webhook", requestBody: { content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, events: { type: "array", items: { type: "string" } }, description: { type: "string" } }, required: ["url"] } } } }, responses: { "201": { description: "创建成功" } } },
      },
      "/api/webhooks/{id}": {
        put: { tags: ["Webhook"], summary: "更新 Webhook", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "更新成功" } } },
        delete: { tags: ["Webhook"], summary: "删除 Webhook", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "删除成功" } } },
      },
      "/api/webhooks/{id}/test": {
        post: { tags: ["Webhook"], summary: "发送测试事件", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "测试事件已发送" } } },
      },
      "/api/webhooks/{id}/deliveries": {
        get: { tags: ["Webhook"], summary: "查看投递日志", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "投递日志列表" } } },
      },

      // ===== 审计 =====
      "/api/audit": {
        get: { tags: ["审计日志"], summary: "查询审计日志", parameters: [{ name: "category", in: "query", schema: { type: "string" } }, { name: "level", in: "query", schema: { type: "string" } }, { name: "dateFrom", in: "query", schema: { type: "string" } }, { name: "dateTo", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "审计日志", content: { "application/json": { schema: { type: "object", properties: { logs: { type: "array", items: { $ref: "#/components/schemas/AuditLog" } }, total: { type: "integer" } } } } } } } },
      },
      "/api/audit/stats": {
        get: { tags: ["审计日志"], summary: "审计统计", responses: { "200": { description: "统计数据" } } },
      },

      // ===== 备份 =====
      "/api/backups": {
        get: { tags: ["备份恢复"], summary: "列出备份", responses: { "200": { description: "备份列表", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/BackupInfo" } } } } } } },
        post: { tags: ["备份恢复"], summary: "创建备份", requestBody: { content: { "application/json": { schema: { type: "object", properties: { type: { type: "string", enum: ["full", "db-only"] }, description: { type: "string" } } } } } }, responses: { "201": { description: "备份信息" } } },
      },
      "/api/backups/{filename}/download": {
        get: { tags: ["备份恢复"], summary: "下载备份文件", parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "备份文件" } } },
      },
      "/api/backups/{filename}/restore": {
        post: { tags: ["备份恢复"], summary: "从备份恢复", parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "恢复结果" } } },
      },

      // ===== 导出 =====
      "/api/export/{noteId}": {
        get: { tags: ["导出"], summary: "导出笔记", parameters: [{ name: "noteId", in: "path", required: true, schema: { type: "string" } }, { name: "format", in: "query", schema: { type: "string", enum: ["markdown", "html", "json", "txt"] } }], responses: { "200": { description: "导出内容" } } },
      },

      // ===== 分享 =====
      "/api/shares": {
        get: { tags: ["分享"], summary: "获取分享列表", responses: { "200": { description: "分享列表" } } },
        post: { tags: ["分享"], summary: "创建分享链接", responses: { "201": { description: "分享信息" } } },
      },

      // ===== 系统 =====
      "/api/health": {
        get: { tags: ["系统"], summary: "健康检查", security: [], responses: { "200": { description: "服务状态" } } },
      },
      "/api/settings": {
        get: { tags: ["系统"], summary: "获取系统设置", security: [], responses: { "200": { description: "设置信息" } } },
        put: { tags: ["系统"], summary: "更新系统设置", responses: { "200": { description: "更新成功" } } },
      },
      "/api/me": {
        get: { tags: ["系统"], summary: "获取当前登录用户信息", responses: { "200": { description: "用户信息" } } },
      },
      "/api/openapi.json": {
        get: { tags: ["系统"], summary: "获取 OpenAPI 规范", security: [], responses: { "200": { description: "OpenAPI JSON" } } },
      },
    },
    tags: [
      { name: "认证", description: "用户认证管理" },
      { name: "笔记本", description: "笔记本 CRUD" },
      { name: "笔记", description: "笔记 CRUD（含收藏、置顶、回收站）" },
      { name: "标签", description: "标签管理" },
      { name: "任务", description: "待办任务管理" },
      { name: "思维导图", description: "思维导图管理" },
      { name: "搜索", description: "全文搜索" },
      { name: "AI", description: "AI 写作助手与知识库问答" },
      { name: "插件", description: "插件管理与执行" },
      { name: "Webhook", description: "Webhook 事件推送" },
      { name: "审计日志", description: "操作审计日志" },
      { name: "备份恢复", description: "数据备份与恢复" },
      { name: "导出", description: "笔记导出" },
      { name: "分享", description: "笔记分享" },
      { name: "系统", description: "系统设置与健康检查" },
    ],
  };
}
