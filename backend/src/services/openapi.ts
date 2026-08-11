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
            content: { type: "string", description: "笔记内容；contentFormat=markdown 时为 Markdown 源文，tiptap-json 时为 Tiptap JSON" },
            contentText: { type: "string", description: "纯文本内容" },
            contentFormat: { type: "string", enum: ["tiptap-json", "markdown", "html"], description: "内容格式" },
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
            priority: { type: "integer", description: "1=低 2=中 3=高" },
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
        AttachmentStorageConfig: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            endpoint: { type: "string" },
            region: { type: "string" },
            bucket: { type: "string" },
            accessKeyId: { type: "string" },
            prefix: { type: "string" },
            secretAccessKeySet: { type: "boolean" },
            source: { type: "string", enum: ["settings", "env", "default"] },
            updatedAt: { type: "string", nullable: true },
          },
        },
        AttachmentStorageStatus: {
          type: "object",
          properties: {
            storage: {
              type: "object",
              properties: {
                driver: { type: "string", enum: ["local", "s3"] },
                localDir: { type: "string" },
                bucket: { type: "string" },
                endpoint: { type: "string" },
                prefix: { type: "string" },
                migrationCommand: { type: "string" },
              },
            },
            database: { type: "object" },
            local: { type: "object" },
            migrationCommand: { type: "string", nullable: true },
            checkedAt: { type: "string", format: "date-time" },
          },
        },
        AttachmentRemoteStorageCheck: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            skipped: { type: "boolean" },
            reason: { type: "string" },
            storage: { type: "object" },
            total: { type: "integer" },
            limit: { type: "integer" },
            checked: { type: "integer" },
            exists: { type: "integer" },
            missing: { type: "array", items: { type: "object" } },
            errors: { type: "array", items: { type: "object" } },
            checkedAt: { type: "string", format: "date-time" },
          },
        },
        AttachmentUploadResponse: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            url: { type: "string", example: "/api/attachments/8b6e..." },
            mimeType: { type: "string" },
            size: { type: "integer" },
            filename: { type: "string" },
            category: { type: "string", enum: ["image", "file"] },
            createdAt: { type: "string", format: "date-time" },
            deduplicated: { type: "boolean", nullable: true },
          },
        },
        FileItem: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            filename: { type: "string" },
            mimeType: { type: "string" },
            size: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            category: { type: "string", enum: ["image", "file"] },
            url: { type: "string" },
            thumbnailUrl: { type: "string" },
            hash: { type: "string", nullable: true },
            folderId: { type: "string", nullable: true },
            folderName: { type: "string", nullable: true },
            primaryNote: { type: "object", nullable: true },
          },
        },
        FileListResponse: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/components/schemas/FileItem" } },
            total: { type: "integer" },
            page: { type: "integer" },
            pageSize: { type: "integer" },
          },
        },
        FileStats: {
          type: "object",
          properties: {
            total: { type: "integer" },
            images: { type: "integer" },
            files: { type: "integer" },
            bytes: { type: "integer" },
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
        post: { tags: ["笔记"], summary: "创建笔记", requestBody: { content: { "application/json": { schema: { type: "object", properties: { notebookId: { type: "string" }, title: { type: "string" }, content: { type: "string" }, contentText: { type: "string" }, contentFormat: { type: "string", enum: ["tiptap-json", "markdown", "html"], default: "tiptap-json" } }, required: ["notebookId"] } } } }, responses: { "201": { description: "创建成功" } } },
      },
      "/api/notes/{id}": {
        get: { tags: ["笔记"], summary: "获取笔记详情", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "笔记详情", content: { "application/json": { schema: { $ref: "#/components/schemas/Note" } } } } } },
        put: { tags: ["笔记"], summary: "更新笔记", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, contentText: { type: "string" }, contentFormat: { type: "string", enum: ["tiptap-json", "markdown", "html"] }, version: { type: "integer", description: "内容类更新必须携带当前笔记 version" } } } } } }, responses: { "200": { description: "更新成功" } } },
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

      // ===== 附件 / 文件 =====
      "/api/attachments": {
        post: {
          tags: ["附件"],
          summary: "上传并绑定到指定笔记的附件",
          description: "复用 Web 编辑器上传入口。请求必须是 multipart/form-data，file 和 noteId 均必填；后端会校验当前用户对 noteId 的 write 权限。",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    noteId: { type: "string", description: "目标笔记 ID" },
                  },
                  required: ["file", "noteId"],
                },
              },
            },
          },
          responses: {
            "201": { description: "上传成功", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentUploadResponse" } } } },
            "200": { description: "去重命中时返回已存在附件的新绑定记录", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentUploadResponse" } } } },
            "400": { description: "multipart body 或 noteId 不合法", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "403": { description: "无权向该笔记上传附件" },
          },
        },
      },
      "/api/attachments/{id}": {
        get: {
          tags: ["附件"],
          summary: "下载或内联预览附件",
          description: "该下载 handler 挂在 JWT 中间件之前，以支持浏览器原生 <img src>。私有部署可结合签名 URL 或不可枚举 UUID 使用。",
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "download", in: "query", schema: { type: "string", enum: ["1"] }, description: "强制下载" },
            { name: "inline", in: "query", schema: { type: "string", enum: ["1"] }, description: "非图片附件内联预览" },
            { name: "w", in: "query", schema: { type: "integer" }, description: "图片缩略图宽度" },
          ],
          responses: {
            "200": { description: "附件二进制内容" },
            "404": { description: "附件不存在或物理文件缺失" },
          },
        },
        delete: {
          tags: ["附件"],
          summary: "删除单个附件",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "删除成功" },
            "403": { description: "无权删除该附件" },
            "404": { description: "附件不存在" },
          },
        },
      },
      "/api/files": {
        get: {
          tags: ["文件"],
          summary: "列出文件管理中的附件",
          parameters: [
            { name: "category", in: "query", schema: { type: "string", enum: ["all", "image", "file"], default: "all" } },
            { name: "filter", in: "query", schema: { type: "string", enum: ["unreferenced", "myUploads"] } },
            { name: "myUploadsRef", in: "query", schema: { type: "string", enum: ["referenced", "unreferenced"] } },
            { name: "mime", in: "query", schema: { type: "string" } },
            { name: "notebookId", in: "query", schema: { type: "string" } },
            { name: "noteId", in: "query", schema: { type: "string" }, description: "只返回被该笔记引用过的附件" },
            { name: "folderId", in: "query", schema: { type: "string" }, description: "附件文件夹 ID；__unarchived 表示未归档" },
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["name_asc", "name_desc", "size_asc", "size_desc", "created_asc", "created_desc"] } },
            { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1 } },
            { name: "pageSize", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 200 } },
            { name: "workspaceId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "文件列表", content: { "application/json": { schema: { $ref: "#/components/schemas/FileListResponse" } } } },
          },
        },
      },
      "/api/files/stats": {
        get: {
          tags: ["文件"],
          summary: "获取文件统计",
          parameters: [{ name: "workspaceId", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "文件统计", content: { "application/json": { schema: { $ref: "#/components/schemas/FileStats" } } } } },
        },
      },
      "/api/files/{id}": {
        get: {
          tags: ["文件"],
          summary: "获取文件详情和反向引用",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "文件详情", content: { "application/json": { schema: { $ref: "#/components/schemas/FileItem" } } } },
            "404": { description: "文件不存在" },
          },
        },
        patch: {
          tags: ["文件"],
          summary: "重命名文件",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } } } },
          responses: { "200": { description: "重命名成功" }, "400": { description: "文件名不合法" }, "403": { description: "无权重命名" } },
        },
        delete: {
          tags: ["文件"],
          summary: "删除文件",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "删除成功" }, "403": { description: "无权删除" }, "404": { description: "文件不存在" } },
        },
      },
      "/api/files/upload": {
        post: {
          tags: ["文件"],
          summary: "上传未绑定笔记的文件",
          description: "文件管理页上传入口。后端会创建或复用隐藏的“文件管理（自动）/未归档文件”占位笔记来满足附件外键。",
          parameters: [{ name: "workspaceId", in: "query", schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    folderId: { type: "string", description: "附件文件夹 ID，可选" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "201": { description: "上传成功", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentUploadResponse" } } } },
            "200": { description: "去重命中", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentUploadResponse" } } } },
          },
        },
      },
      "/api/files/batch-delete": {
        post: {
          tags: ["文件"],
          summary: "批量删除文件",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ids: { type: "array", items: { type: "string" }, maxItems: 200 } },
                  required: ["ids"],
                },
              },
            },
          },
          responses: { "200": { description: "批量删除结果" }, "400": { description: "ids 不合法" } },
        },
      },

      // ===== Attachment Storage =====
      "/api/attachments/_storage/status": {
        get: {
          tags: ["Attachment Storage"],
          summary: "Get attachment storage status and migration summary",
          responses: { "200": { description: "Attachment storage status", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentStorageStatus" } } } } },
        },
      },
      "/api/attachments/_storage/config": {
        get: {
          tags: ["Attachment Storage"],
          summary: "Get object storage config",
          responses: { "200": { description: "Object storage config", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentStorageConfig" } } } } },
        },
        put: {
          tags: ["Attachment Storage"],
          summary: "Save object storage config (admin sudo required)",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    endpoint: { type: "string" },
                    region: { type: "string", default: "auto" },
                    bucket: { type: "string" },
                    accessKeyId: { type: "string" },
                    secretAccessKey: { type: "string", description: "Leave empty to keep the saved secret." },
                    prefix: { type: "string" },
                  },
                  required: ["enabled"],
                },
              },
            },
          },
          responses: { "200": { description: "Saved object storage config", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentStorageConfig" } } } } },
        },
        delete: {
          tags: ["Attachment Storage"],
          summary: "Delete saved object storage config and return to env/default source (admin sudo required)",
          responses: { "200": { description: "Effective config after deletion", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentStorageConfig" } } } } },
        },
      },
      "/api/attachments/_storage/test": {
        post: {
          tags: ["Attachment Storage"],
          summary: "Test current object storage config (admin sudo required)",
          responses: { "200": { description: "Test result", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } } },
        },
      },
      "/api/attachments/_storage/remote-check": {
        get: {
          tags: ["Attachment Storage"],
          summary: "Sample-check whether DB attachment paths exist in remote object storage",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 200 } }],
          responses: { "200": { description: "Remote check result", content: { "application/json": { schema: { $ref: "#/components/schemas/AttachmentRemoteStorageCheck" } } } } },
        },
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
      { name: "附件", description: "附件上传、下载与删除" },
      { name: "文件", description: "文件管理列表、详情、上传、重命名和删除" },
      { name: "Attachment Storage", description: "Local attachment and S3-compatible object storage management" },
      { name: "分享", description: "笔记分享" },
      { name: "系统", description: "系统设置与健康检查" },
    ],
  };
}
