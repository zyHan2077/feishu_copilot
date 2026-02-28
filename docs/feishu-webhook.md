# Feishu Webhook 验签与事件订阅

本文档记录飞书事件推送的验签算法和需要订阅的事件类型。

---

## 1. Webhook 验签说明（加密模式）

飞书开启 Encrypt Key 后，事件以 `{ "encrypt": "..." }` 形式到达。解密流程：

1. `key = SHA256(encryptKey)` 的前 32 字节
2. `buf = base64decode(encrypted)`
3. `iv = buf[0:16]`，`ciphertext = buf[16:]`
4. AES-256-CBC 解密 → JSON

解密成功后，用**解密后的 body** 做 token 验证：
- v1 事件：`body.token === FEISHU_VERIFICATION_TOKEN`
- v2 事件：`body.header.token === FEISHU_VERIFICATION_TOKEN`

> ⚠️ **常见 Bug**：用加密原文（`req.body = { encrypt: "..." }`）做 token 验证，永远失败 → 返回 401 → 事件丢弃。  
> **正确做法**：解密后将 decryptedBody 传入验签函数，用 decryptedBody 的 token 字段比对。

### X-Lark-Signature 算法

飞书 `X-Lark-Signature` 的正确算法是 **SHA256**（非 HMAC）：

```
signature = sha256(timestamp + nonce + encryptKey + rawBody).hexdigest()
```

---

## 2. 需订阅的事件类型

飞书开放平台需订阅以下事件，机器人才能正常工作：

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1` | 收到群消息（@mention 及话题回复） |
| `im.chat.member.bot.added_v1` | 机器人被邀请进群 → 自动发初始化提示 |

---

## 3. 消息事件关键字段

`im.message.receive_v1` 事件 body 中 `event.message` 的常用字段：

| 字段 | 说明 |
|---|---|
| `message_id` | 本条消息 ID（`om_xxx`） |
| `chat_id` | 群聊 ID（`oc_xxx`） |
| `chat_type` | `"group"` / `"p2p"` |
| `thread_id` | 话题 ID（`omt_xxx`），仅话题消息有 |
| `root_id` | 话题锚点消息 ID，用于话题检测备用 |
| `content` | JSON 字符串，文本消息格式：`{"text": "..."}` |
| `mentions` | `@` 提及列表，含 `id.open_id` |

`event.sender.sender_id.open_id` 是发送者的 open_id，用于访问控制。
