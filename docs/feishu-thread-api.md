# Feishu Thread API (话题) — Reference

Feishu 话题（Thread）是挂在某条消息下的子话题流。本文档记录了与话题相关的所有 API 调用细节，以及调试过程中发现的关键注意事项。

---

## 1. 创建话题

在某条已存在的消息下创建话题，方法是**回复该消息**并带上 `reply_in_thread: true`。

```
POST /im/v1/messages/{message_id}/reply
Authorization: Bearer <tenant_access_token>

{
  "msg_type": "text",
  "content": "{\"text\": \"话题首条消息内容\"}",
  "reply_in_thread": true
}
```

### ⚠️ 响应结构陷阱

飞书回复 API 的响应结构与发消息 API **不同**：

| API | 新消息的字段位置 |
|---|---|
| `POST /im/v1/messages` (发消息) | `resp.data.data.message_id` |
| `POST /im/v1/messages/{id}/reply` (回复) | `resp.data.data.message_id` ← 直接在 `.data` 下，**无** `.message` 嵌套层 |

**错误写法**（会导致 `thread_id` 永远为空字符串）：
```typescript
const d = resp.data?.data?.message;   // ❌ .message 不存在
```

**正确写法**：
```typescript
const d = resp.data?.data ?? {};      // ✅ 直接取 .data
const threadId = d.thread_id as string;
const messageId = d.message_id as string;
```

---

## 2. 向已有话题发送消息

```
POST /im/v1/messages?receive_id_type=thread_id
Authorization: Bearer <tenant_access_token>

{
  "receive_id": "oThread_xxxxxxxxxxxxxxxxxx",
  "msg_type": "text",
  "content": "{\"text\": \"消息内容\"}"
}
```

响应结构：`resp.data.data.message_id`（与发消息 API 一致）。

---

## 3. 修改话题标题

```
PATCH /im/v1/threads/{thread_id}
Authorization: Bearer <tenant_access_token>

{
  "name": "新标题"
}
```

- `thread_id` 格式为 `omt_xxxxxxxxxxxxxxxx`（以 `omt_` 开头）。
- 此 API 权限较严格，建议用 `try/catch` 包裹并 **graceful fail**（失败不影响主流程）。

---

## 4. Webhook 事件中的话题字段

当用户在话题中回复时，飞书推送的 `im.message.receive_v1` 事件的 `message` 对象包含：

| 字段 | 说明 | 示例值 |
|---|---|---|
| `message.thread_id` | 话题 ID（`omt_` 前缀） | `"omt_1ac69f01830f1be3"` |
| `message.root_id` | 话题锚点消息 ID（创建话题时被回复的那条消息） | `"om_xxxxxxxxxx"` |
| `message.parent_id` | 直接回复的上一条消息 ID | `"om_xxxxxxxxxx"` |

> `thread_id` 仅在消息属于话题时才存在；普通群消息没有该字段。

---

## 5. 话题检测策略（双重判断）

仅凭 `thread_id` 可能在边缘情况下失效（例如 `replyInThread` 返回空串时），建议使用**双重判断**：

```typescript
// 主判断：thread_id 匹配
const isFromCopilotThread = msg.threadId === state.copilot_thread_id;

// 备用判断：root_id 匹配（消息是对话题锚点消息的回复）
const isRootedAtAnchor = msg.rootMsgId === state.copilot_anchor_msg_id;

if (isFromCopilotThread || isRootedAtAnchor) {
  // 属于 Copilot 话题，转发给 Copilot CLI
}
```

状态中需同时存储：
```typescript
{
  copilot_thread_id: string;       // "omt_xxx"
  copilot_anchor_msg_id: string;   // 锚点消息的 message_id
}
```

---

## 6. 完整调用示例（TypeScript）

参见 `src/feishu/client.ts`：
- `replyInThread(messageId, text)` — 创建话题并回复
- `sendToThread(threadId, text)` — 向话题发送消息
- `updateThreadName(threadId, name)` — 修改话题标题

---

## 7. 已知限制

- `updateThreadName` 需要 bot 具有**管理话题**权限，若权限不足会静默失败。
