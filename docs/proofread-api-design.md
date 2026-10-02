# 核稿 API 设计文档

## 概述

不新增异步核稿任务系统，而是利用 rdCLI 现有的聊天能力：OA 系统调用一个端点创建预填充的核稿会话，返回链接后用户点击跳转到 rdCLI 聊天界面，在对话中完成核稿。

核稿过程就是一次正常的聊天会话——Claude 读到 docx 文件，按 System Prompt 要求进行校对，用户可以在聊天窗口里追问、精修、追加指令。

---

## 架构

```
OA 办公系统                                  rdCLI
   │                                          │
   │  用户点击 [核稿]                          │
   │                                          │
   │  POST /api/proofread/session             │
   │  file: <docx>                            │
   │  style: "government"                     │
   │  additional_instructions: "重点查数据"      │
   │  Authorization: API Key                  │
   │─────────────────────────────────────────►│
   │                                          │
   │                                          │ 1. 存储 docx 到 assets
   │                                          │ 2. 创建 Claude session
   │                                          │ 3. 注入 System Prompt（核稿模板）
   │                                          │ 4. 首条消息 = "请核稿" + 文档引用
   │                                          │ 5. 等待 Claude 完成首轮回复
   │                                          │
   │  { session_id, session_url }             │
   │◄─────────────────────────────────────────│
   │                                          │
   │  新窗口打开 session_url                   │
   │─────────────────────────────────────────►│  聊天界面，用户看到核稿结果
   │                                          │  可以追问、追加指令
```

---

## API 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| `POST` | `/api/proofread/session` | API Key | 上传 docx → 创建核稿会话 → 返回链接 |

---

## POST /api/proofread/session

### 请求

```
POST /api/proofread/session
Authorization: Bearer <API_Key>
Content-Type: multipart/form-data
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | Word 文档（.docx），最大 20MB |
| `additional_instructions` | string | 否 | 用户追加的核稿要求 |

### 响应 (200)

```json
{
  "success": true,
  "data": {
    "session_id": "abc123-def456",
    "session_url": "https://rdcli.example.com/chat?session=abc123-def456"
  }
}
```

### 错误响应 (400)

```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_FORMAT",
    "message": "仅支持 .docx 格式"
  }
}
```

---

## 服务端处理流程

```
POST /api/proofread/session
│
├─ 1. multer 接收文件 → 存入 ~/.rdcli/assets/<userId>/ （复用现有 assets 存储）
│
├─ 2. 创建 Claude session
│     providerRuntimeService.run('claude', userMessage, {
│       sessionId: null,           // 新会话
│       permissionMode: 'bypassPermissions',
│       cwd: projectPath,
│       files: [docx 文件的路径],   // Claude 可以 Read 它
│     }, writer)
│
├─ 3. User Message：
│     "请校对审读这篇文档。"
│     + (additional_instructions ? "\n\n" + additional_instructions : "")
│
├─ 4. 等待 Claude 完成首轮回复（收集 assistant 消息直到 complete）
│
└─ 5. 返回 session_id + session_url
```

### 关键细节

- **docx 不预解析**：Claude 有 Read 工具，可以自己读取 Word 文档。文件存到 assets 后通过 `files` 参数传入，Claude 会在首轮自动读取。
- **会话持续有效**：返回的 session_id 就是正常的聊天会话，用户可以继续对话。
- **鉴权**：复用 agent.routes.ts 中的 `validateExternalApiKey` 逻辑，支持 API Key 和 Platform 两种模式。

---

## 核稿标准

程序不注入任何核稿 Prompt 或模式参数。核稿标准完全定义在容器的全局 CLAUDE.md

中（`docker/CLAUDE.md` 的「文稿校对审读」章节），Claude 启动时自动加载，

根据文档内容自行判断适用标准。

CLAUDE.md 预定义了两套标准：
- **通用文稿校对**：错别字、语法、逻辑、表达优化等
- **党政机关公文核稿**：依据 GB/T 9704-2012，逐项检查文种、标题、发文字号、主送机关等

User Message 仅一句 `"请校对审读这篇文档。"`，不做额外限定。

用户通过 `additional_instructions` 追加的指令直接拼在末尾。

---

## 技术实现

### 新增文件

```
server/modules/proofread/
├── index.ts                  # 模块入口 barrel
├── proofread.module.ts       # 组装依赖 → 导出 router
├── proofread.routes.ts       # POST /api/proofread/session
├── proofread.service.ts      # 创建会话、返回 session_url
└── prompt-templates.ts       # 核稿 System Prompt 模板
```

### 修改现有文件

| 文件 | 改动 |
|------|------|
| `server/modules/providers/list/claude/claude-runtime.provider.js` | `mapCliOptionsToSDK` 中支持 `customSystemPrompt` 参数覆盖默认 system prompt |
| `server/index.ts` | 挂载 `app.use('/api/proofread', proofreadRoutes)` |
| `server/modules/providers/shared/` | **不新增** provider 类型，核稿只用现有的 claude provider |

### 依赖

- **零新增 npm 依赖**。不引入 mammoth，Claude 自己读 docx。
- 复用 `multer`（已安装）：文件上传
- 复用 `providerRuntimeService.run()`：驱动 Claude 会话
- 复用 assets 存储路径 `~/.rdcli/assets/`：存储上传的 docx

### 鉴权

复用 agent.routes.ts 中的 `validateExternalApiKey` 中间件模式（提取为共享函数或直接复制）。两种模式：

- **自部署**：`x-api-key` 请求头传递 API Key
- **Platform**：外部代理认证，使用默认用户

---

## OA 系统集成示例

```bash
# 用户点击 [核稿] 按钮，OA 后端调用：
curl -X POST https://rdcli.example.com/api/proofread/session \
  -H "Authorization: Bearer ck_xxxx" \
  -F "file=@来文登记.docx" \
  -F "style=government" \
  -F "additional_instructions=请重点检查涉及财政数据的表述"

# 响应：
# { "session_id": "abc123", "session_url": "https://rdcli.example.com/chat?session=abc123" }

# OA 前端拿到 session_url → window.open() 新窗口打开
# 用户看到 Claude 已经核稿完成，可以继续对话
```

---

## 和完整异步 API 方案的对比

| | 异步 API 方案 | 会话跳转方案 |
|------|-------------|------------|
| 新增文件 | 8 个 | 5 个 |
| 新增 npm 依赖 | mammoth | **零** |
| 新增 DB 表 | proofread_tasks | **零** |
| 回调/重试机制 | 需要 | 不需要 |
| OA 结果渲染 | 需开发 JSON→UI | 不需要（聊天窗口展示） |
| 用户交互 | 无 | 可追问、追加指令 |
| Claude 能力 | 单轮 API 调用 | 多轮对话、工具调用（Read docx） |
| 实现工时 | 大 | 小 |
| 适用场景 | 全自动批量核稿 | 人工复审 + AI 辅助 |

---

## 后续演进

如果客户反馈"每篇都跳转太麻烦，想要批量自动核稿"，可以在本方案基础上追加：

- `proofread_tasks` 表 → 记录任务状态
- `POST /api/proofread`（异步）→ 创建任务 + 立即返回 taskId
- 回调机制 → 完成后通知 OA

届时本方案的 `proofread.service.ts` 可以直接作为异步方案的核心引擎。

---

## 审阅记录

| 日期 | 审阅人 | 意见 |
|------|--------|------|
| 2025-01-15 | — | 初稿（会话跳转方案） |