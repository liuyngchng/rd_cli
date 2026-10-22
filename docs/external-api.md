# rdCLI 外部 API 文档

rdCLI 提供 HTTP API，允许外部程序通过 API Key 提交文档或代码任务给 Claude Code 处理。

---

## 目录

- [鉴权方式](#鉴权方式)
- [API 1：文档核稿（异步）](#api-1文档核稿异步) — 提交文档，轮询获取 Markdown 核稿意见
- [API 2：文档核稿（会话跳转）](#api-2文档核稿会话跳转) — 提交文档，返回聊天链接供人工复核
- [API 3：通用 Agent](#api-3通用-agent) — 触发 Claude 操作代码仓库
- [获取 API Key](#获取-api-key)
- [附录](#附录)

---

## 鉴权方式

所有 API 均通过 `x-api-key` 请求头进行鉴权。支持两种模式：

### 模式一：自部署（API Key）

在 rdCLI 网页界面生成一个 API Key（`ck_` 开头），调用时附加到请求头：

```http
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

该 Key 与创建它的用户绑定，所有操作以该用户的身份执行。

### 模式二：Platform 模式

当 rdCLI 以 `VITE_IS_PLATFORM=true` 启动时，认证由外部代理处理，API 请求无需提供 Key，系统自动使用数据库中的首个用户。

---

## API 1：文档核稿（异步）

提交 .docx 文档创建异步核稿任务，任务在后台由 Claude 处理。调用方轮询任务状态，完成后直接拿到 Markdown 格式的核稿意见，无需人工介入。

> 推荐用于 OA 系统集成等全自动场景。如果需要人工复核和追问，请使用 [API 2：文档核稿（会话跳转）](#api-2文档核稿会话跳转)。

### 整体流程

```
OA 系统                                          rdCLI
   │                                               │
   │  POST /api/proofread                          │
   │  file: <docx>                                 │
   │──────────────────────────────────────────────►│  立即返回 taskId
   │                                               │
   │  { task_id: "pt-xxx", status: "pending" }     │
   │◄──────────────────────────────────────────────│
   │                                               │  Claude 后台核稿...
   │  GET /api/proofread/pt-xxx                    │
   │──────────────────────────────────────────────►│
   │                                               │
   │  { status: "processing" }                     │
   │◄──────────────────────────────────────────────│
   │                                               │
   │  ... 等待至少 10 秒，再次查询 ...              │
   │                                               │
   │  GET /api/proofread/pt-xxx                    │
   │──────────────────────────────────────────────►│
   │                                               │
   │  { status: "completed",                       │
   │    result_text: "## 核稿结果\n\n### 1. ..." }  │
   │◄──────────────────────────────────────────────│  ← 拿到核稿意见 Markdown
```

### POST /api/proofread — 提交任务

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `multipart/form-data` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**表单字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `file` | file | ✅ | Word 文档（.docx），最大 20MB |
| `additional_instructions` | string | | 追加的核稿要求，例如"重点检查数据引用"、"只看格式问题" |

**响应（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "pending"
  }
}
```

| 字段 | 说明 |
|------|------|
| `task_id` | 任务 ID，后续轮询用 |
| `status` | 初始状态固定为 `"pending"` |

**错误响应（400）：**

```json
{
  "success": false,
  "error": {
    "code": "MISSING_FILE",
    "message": "请上传 .docx 格式的 Word 文档"
  }
}
```

| 错误码 | 说明 |
|--------|------|
| `MISSING_FILE` | 未上传文件 |
| `UNSUPPORTED_FORMAT` | 文件格式不被接受（仅支持 .docx） |
| `UPLOAD_FAILED` | 文件上传失败（如超过 20MB 上限） |
| `TOO_MANY_TASKS` | 同时处理的核稿任务已达上限（5 个），需等待已有任务完成 |

**错误响应（401）：**

```json
{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication required"
  }
}
```

---

### GET /api/proofread/:taskId — 查询任务

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `GET` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**响应 — 排队中（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "pending",
    "file_name": "来文登记.docx",
    "created_at": "2026-10-22T10:00:00Z",
    "updated_at": "2026-10-22T10:00:00Z"
  }
}
```

**响应 — 处理中（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "processing",
    "file_name": "来文登记.docx",
    "created_at": "2026-10-22T10:00:00Z",
    "updated_at": "2026-10-22T10:00:05Z"
  }
}
```

**响应 — 已完成（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "completed",
    "file_name": "来文登记.docx",
    "file_size": 45678,
    "additional_instructions": "重点检查数据引用",
    "result_text": "## 核稿结果\n\n### 1. 错别字\n\n- **原文**：截至2025年12月底，全市生产总值达到120亿元。\n- **修改建议**：\"截至\"后缺少逗号，应为\"截至 2025 年 12 月底\"。\n- **修改理由**：数字与中文之间应留空格，保持全文格式统一。\n\n### 2. 数据问题\n\n- **原文**：较上年增长8.5%。\n- **修改建议**：请核实增长率 8.5% 是否准确，前文提到基数为 110 亿，推算增长约为 9.1%。\n- **修改理由**：数据前后不一致，需核实后修正。\n\n### 3. 标点符号\n\n...",
    "tokens": {
      "inputTokens": 3840,
      "outputTokens": 1250,
      "totalTokens": 5090
    },
    "session_id": "proofread-mabc123-4f3a2b1c",
    "session_url": "https://rdcli.example.com/chat?session=proofread-mabc123-4f3a2b1c",
    "created_at": "2026-10-22T10:00:00Z",
    "updated_at": "2026-10-22T10:02:30Z"
  }
}
```

| 字段 | 说明 |
|------|------|
| `result_text` | **核稿意见全文，Markdown 格式**。Claude 按核稿标准逐项审查后输出 |
| `tokens` | Token 消耗统计 |
| `session_id` / `session_url` | 关联的聊天会话，可用于人工复核 |

**响应 — 失败（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "failed",
    "file_name": "来文登记.docx",
    "error_message": "Claude is not installed. Please install it first.",
    "created_at": "2026-10-22T10:00:00Z",
    "updated_at": "2026-10-22T10:00:15Z"
  }
}
```

**响应 — 任务不存在（404）：**

```json
{
  "success": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "任务不存在"
  }
}
```

**响应 — 查询过于频繁（429）：**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "请至少间隔 10 秒再查询"
  }
}
```

### 任务状态流转

```
pending ──→ processing ──→ completed
          │    │                │
          └────┼──→ cancelled   │
               │                │
               └──→ failed      │
                                │
                (pending 也可取消)
```

| 状态 | 含义 |
|------|------|
| `pending` | 已提交，等待处理 |
| `processing` | Claude 正在核稿中 |
| `completed` | 核稿完成，`result_text` 字段有内容 |
| `failed` | 核稿失败，`error_message` 字段有错误原因 |
| `cancelled` | 已撤销，`error_message` 字段有撤销说明 |

### 轮询建议

- **查询频率限制**：同一任务 **至少间隔 10 秒** 才能查询一次，过于频繁会返回 `429` 错误
- 建议间隔 **10 - 15 秒** 轮询一次
- 核稿通常在 **30 秒 - 2 分钟** 内完成（取决于文档大小和复杂度）
- `completed` 和 `failed` 是终态，达到后即可停止轮询

### 并发限制

同一用户**同时处理中的核稿任务不超过 5 个**。超过上限后提交新任务会立即返回 `429` 错误（错误码 `TOO_MANY_TASKS`），需等待已有任务完成。

---

### GET /api/proofread — 查询进行中的任务列表

返回当前用户所有**未完成**（pending + processing）的核稿任务，按创建时间倒序。

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `GET` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**响应（200）：**

```json
{
  "success": true,
  "data": [
    {
      "task_id": "pt-mabc123-x7k2",
      "status": "processing",
      "file_name": "来文登记.docx",
      "file_size": 45678,
      "additional_instructions": "重点检查数据引用",
      "created_at": "2026-10-22T10:00:00Z",
      "updated_at": "2026-10-22T10:00:05Z"
    },
    {
      "task_id": "pt-nxyz456-a3b1",
      "status": "pending",
      "file_name": "通知.docx",
      "file_size": 12345,
      "created_at": "2026-10-22T09:55:00Z",
      "updated_at": "2026-10-22T09:55:00Z"
    }
  ]
}
```

**调用示例：**

```bash
curl -X GET https://rdcli.example.com/api/proofread \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 空列表：
# { "success": true, "data": [] }
```

---

### DELETE /api/proofread/:taskId — 撤销任务

撤销一个等待中或处理中的核稿任务。如果任务正在运行，将强制中断底层的 Claude 会话。

> ⚠️ 已完成（completed）或已失败（failed）的任务不能撤销，会返回 404。

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `DELETE` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**响应（200）：**

```json
{
  "success": true,
  "data": {
    "task_id": "pt-mabc123-x7k2",
    "status": "cancelled",
    "updated_at": "2026-10-22T10:01:30Z"
  }
}
```

**响应 — 失败（404）：**

```json
{
  "success": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "任务不存在或已完成，无法撤销"
  }
}
```

**调用示例：**

```bash
curl -X DELETE https://rdcli.example.com/api/proofread/pt-mabc123-x7k2 \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 响应：
# { "success": true, "data": { "task_id": "pt-mabc123-x7k2", "status": "cancelled", "updated_at": "..." } }
```

---

### 调用示例

```bash
# Step 1：提交任务
curl -X POST https://rdcli.example.com/api/proofread \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "file=@来文登记.docx" \
  -F "additional_instructions=重点检查涉及财政数据的表述"

# 响应：
# { "success": true, "data": { "task_id": "pt-mabc123-x7k2", "status": "pending" } }

# Step 2：轮询结果
curl -X GET https://rdcli.example.com/api/proofread/pt-mabc123-x7k2 \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# processing → 继续等
# { "success": true, "data": { "status": "processing", ... } }

# completed → 拿到结果
# { "success": true, "data": { "status": "completed", "result_text": "## 核稿结果\n...", ... } }

# cancelled/failed → 任务被终止
# { "success": true, "data": { "status": "cancelled", "error_message": "任务已撤销", ... } }

# Step 3(optional)：撤销一个处理中的任务
curl -X DELETE https://rdcli.example.com/api/proofread/pt-mabc123-x7k2 \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 响应：
# { "success": true, "data": { "task_id": "pt-mabc123-x7k2", "status": "cancelled", "updated_at": "..." } }
```

### OA 系统集成示例（Node.js）

```javascript
// 用户点击 [核稿] → OA 后端提交任务 → 轮询获取结果 → 展示在 OA 页面

async function proofreadDocument(fileBuffer, fileName, instructions = '') {
  const form = new FormData();
  form.append('file', fileBuffer, fileName);
  if (instructions) {
    form.append('additional_instructions', instructions);
  }

  // Step 1：提交任务
  const submitRes = await fetch('https://rdcli.example.com/api/proofread', {
    method: 'POST',
    headers: { 'x-api-key': process.env.RDCLI_API_KEY },
    body: form
  });
  const { data: { task_id } } = await submitRes.json();

  // Step 2：轮询直到完成
  while (true) {
    await sleep(12000);  // 每 12 秒查一次（API 限制至少间隔 10 秒）
    const pollRes = await fetch(
      `https://rdcli.example.com/api/proofread/${task_id}`,
      { headers: { 'x-api-key': process.env.RDCLI_API_KEY } }
    );

    // 429 = 查询过于频繁，等久一点再试
    if (pollRes.status === 429) {
      await sleep(10000);
      continue;
    }

    const { data } = await pollRes.json();

    if (data.status === 'completed') {
      return {
        task_id,
        result_text: data.result_text,    // Markdown 核稿意见
        tokens: data.tokens,
        session_url: data.session_url     // 如需人工复核可打开
      };
    }
    if (data.status === 'failed') {
      throw new Error(data.error_message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
```

---

## API 2：文档核稿（会话跳转）

上传 .docx 文档，创建一个预填充的核稿会话。Claude 在后台开始核稿，**立即返回会话链接**，用户打开链接后在聊天界面查看核稿结果并可以继续追问。

> 适合需要人工复核、追加指令的场景。如果不需要交互，直接要结果，用 [API 1：文档核稿（异步）](#api-1文档核稿异步)。

### 端点

```
POST /api/proofread/session
```

### 请求

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `multipart/form-data` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**表单字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `file` | file | ✅ | Word 文档（.docx），最大 20MB |
| `additional_instructions` | string | | 追加的核稿要求，例如"重点检查数据引用"、"只看格式问题" |

### 响应

#### 200 — 成功

```json
{
  "success": true,
  "data": {
    "session_id": "proofread-mabc123-4f3a2b1c",
    "session_url": "https://rdcli.example.com/chat?session=proofread-mabc123-4f3a2b1c"
  }
}
```

| 字段 | 说明 |
|------|------|
| `session_id` | Claude 会话 ID |
| `session_url` | 打开后进入聊天界面查看核稿结果，可继续追问 |

#### 400 — 请求错误

```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_FORMAT",
    "message": "仅支持 .docx 格式的 Word 文档"
  }
}
```

| 错误码 | 说明 |
|--------|------|
| `MISSING_FILE` | 未上传文件 |
| `UNSUPPORTED_FORMAT` | 文件格式不被接受（仅支持 .docx） |
| `UPLOAD_FAILED` | 文件上传失败（如超过 20MB 上限） |

#### 401 — 鉴权失败

```json
{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication required"
  }
}
```

### 调用示例

```bash
curl -X POST https://rdcli.example.com/api/proofread/session \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "file=@来文登记.docx" \
  -F "additional_instructions=请重点检查涉及财政数据的表述"

# 响应：
# {
#   "success": true,
#   "data": {
#     "session_id": "proofread-mabc123-4f3a2b1c",
#     "session_url": "https://rdcli.example.com/chat?session=proofread-mabc123-4f3a2b1c"
#   }
# }
```

---

## API 3：通用 Agent

触发 Claude 在指定代码仓库上执行任务。支持克隆 GitHub 仓库、可选的 Git 分支和 PR 创建。

### 端点

```
POST /api/agent
```

### 请求

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**请求体参数：**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|:---:|------|------|
| `message` | string | ✅ | | 任务描述，告诉 Claude 要做什么 |
| `githubUrl` | string | 条件 | | GitHub 仓库 URL（HTTPS 或 SSH），与 `projectPath` 二选一 |
| `projectPath` | string | 条件 | | 本地项目路径，与 `githubUrl` 二选一 |
| `provider` | string | | `"claude"` | AI 提供商，目前仅支持 `"claude"` |
| `model` | string | | 默认模型 | `"default"`、`"sonnet"`、`"opus"`、`"haiku"`、`"fable"` |
| `effort` | string | | | 推理深度：`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` |
| `stream` | boolean | | `true` | `true`=SSE 流式返回，`false`=等待完成后返回 JSON |
| `cleanup` | boolean | | `true` | 完成后是否删除临时克隆的仓库（仅对 githubUrl 生效） |
| `sessionId` | string | | | 指定已有的会话 ID（用于恢复已有会话） |
| `githubToken` | string | | | GitHub Token，覆盖用户设置中存储的 Token |
| `branchName` | string | | | 自定义 Git 分支名，提供后自动启用 createBranch |
| `createBranch` | boolean | | `false` | 任务完成后创建 Git 分支并推送到远程 |
| `createPR` | boolean | | `false` | 任务完成后创建 GitHub Pull Request |

### 路径行为

| 场景 | 输入 | 行为 |
|------|------|------|
| 仅 githubUrl | `githubUrl: "https://github.com/o/r"` | 克隆到 `~/.claude/external-projects/<hash>/`，cleanup 后删除 |
| 仅 projectPath | `projectPath: "/home/user/project"` | 使用已有项目，不清理 |
| 两者都有 | `githubUrl` + `projectPath` | 克隆到指定路径；如路径已存在且 remote 匹配则复用 |

### 响应

#### stream=false（非流式）

```json
{
  "success": true,
  "sessionId": "abc123-def456",
  "messages": [
    {
      "type": "assistant",
      "message": {
        "role": "assistant",
        "content": [{"type": "text", "text": "已完成..."}]
      }
    }
  ],
  "tokens": {
    "inputTokens": 1500,
    "outputTokens": 800,
    "cacheReadTokens": 0,
    "cacheCreationTokens": 0,
    "totalTokens": 2300
  },
  "projectPath": "/home/user/.claude/external-projects/abc123",
  "branch": {
    "name": "fix-bug-lx9abc",
    "url": "https://github.com/owner/repo/tree/fix-bug-lx9abc"
  },
  "pullRequest": {
    "number": 42,
    "url": "https://github.com/owner/repo/pull/42"
  }
}
```

- `branch` 和 `pullRequest` 仅在 `createBranch` / `createPR` 为 true 时出现
- 如果分支/PR 创建失败，对应字段为 `{ "error": "错误描述" }`

#### stream=true（SSE 流式）

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

SSE 事件类型：

| 事件类型 | 说明 |
|----------|------|
| `status` | 状态更新，含 `message` 和 `projectPath` |
| `claude-response` | Claude 的实时输出，`data` 字段为 SDK 消息 |
| `github-branch` | 分支创建成功，含 `branch.name` 和 `branch.url` |
| `github-pr` | PR 创建成功，含 `pullRequest.number` 和 `pullRequest.url` |
| `github-error` | GitHub 操作失败（不影响 Claude 任务本身） |
| `error` | 任务失败的错误信息 |
| `done` | 流结束标记 |

#### 400 — 请求错误

| 错误信息 | 说明 |
|----------|------|
| `Either githubUrl or projectPath is required` | 两个参数都未提供 |
| `message is required` | 未提供任务描述 |
| `provider must be "claude"` | 不支持的 provider |
| `createBranch and createPR require either githubUrl or projectPath with a GitHub remote` | 缺少 GitHub 仓库信息 |

#### 401 — 鉴权失败

```json
{ "error": "API key required" }
```
```json
{ "error": "Invalid or inactive API key" }
```

#### 500 — 服务端错误

```json
{ "success": false, "error": "具体错误描述" }
```

### SSE 流读取示例

```javascript
const response = await fetch('https://rdcli.example.com/api/agent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'ck_xxxx'
  },
  body: JSON.stringify({
    message: '修复所有 TypeScript 类型错误',
    githubUrl: 'https://github.com/owner/repo',
    createPR: true,
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      console.log(data.type, data);
    }
  }
}
```

### 调用示例

```bash
# 克隆仓库并创建 PR（非流式）
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "将所有的 var 声明改为 const/let，并修复 ESLint 报错",
    "githubUrl": "https://github.com/owner/my-project",
    "createPR": true,
    "stream": false
  }'

# 使用已有项目，指定模型（流式）
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "给 UserService 添加单元测试",
    "projectPath": "/home/dev/backend-service",
    "model": "sonnet",
    "stream": true
  }'

# 指定自定义分支名和 PR
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "Refactor database layer to use connection pooling",
    "projectPath": "/home/dev/api-server",
    "branchName": "refactor/db-connection-pool",
    "createPR": true,
    "stream": true
  }'
```

---

## 获取 API Key

1. 登录 rdCLI 网页界面
2. 进入 **设置** → **API Keys**
3. 点击 **创建 API Key**，输入名称（如 "oa-system"）
4. 复制生成的 Key（`ck_` 开头），**仅显示一次**
5. 外部程序调用时通过 `x-api-key` 请求头传入

---

## 附录

### 核稿标准说明

核稿不注入自定义 System Prompt。校对标准完全定义在容器的全局 CLAUDE.md 中（`docker/CLAUDE.md`），Claude 启动时自动加载。

**两套标准：**

- **通用文稿校对**：错别字、标点符号、语法、逻辑矛盾、表达冗余、数字日期名称一致性、标题层级
- **党政机关公文核稿**（GB/T 9704-2012）：文种、标题格式、发文字号、主送机关、正文结构、附件说明、落款、专用语、敏感信息

Claude 根据文档内容自行判断适用标准。核稿输出格式：每条问题包含 **原文**、**修改建议**、**修改理由**。

### 异步核稿 vs 会话跳转 对比

| | API 1：异步核稿 | API 2：会话跳转 |
|---|---|---|
| 端点 | `POST /api/proofread` + `GET /api/proofread/:taskId` | `POST /api/proofread/session` |
| 返回方式 | 先返回 taskId，轮询获取结果 | 立即返回 session_url |
| 结果格式 | Markdown 文本 (`result_text`) | 聊天界面 Claude 回复 |
| 人工交互 | 不支持 | 支持追问、追加指令 |
| 适用场景 | 全自动批量核稿，OA 集成 | 人工复核 |
| 超时风险 | 无（异步轮询） | 无（会话持续有效） |

### Agent API 分支命名规则

当 `createBranch=true` 且未提供 `branchName` 时，分支名由 message 自动生成：

- 英文/数字/连字符保留，特殊字符移除
- 空格转连字符
- 末尾追加 6 位时间戳后缀
- 总长度不超过 50 字符

### 限制说明

| 项目 | 限制 |
|------|------|
| 核稿文件格式 | 仅 `.docx` |
| 核稿文件大小 | 最大 20MB |
| Agent provider | 仅 `claude` |
| 核稿超时 | 无显式上限（异步轮询模式无连接超时问题） |
| Agent 超时 | 无显式上限，由 Claude SDK stream timeout（300 秒空闲）控制 |
| PR 目标分支 | 固定为 `main` |
| cleanup | 仅对 `githubUrl` 克隆的临时项目生效，已有 `projectPath` 不会被清理 |

### 速率限制

所有 `/api` 路径受通用速率限制器保护（`generalApiLimiter`），认证路由另有严格限制（`strictAuthLimiter`）。