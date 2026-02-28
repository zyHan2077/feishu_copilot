import axios from 'axios';

const BASE = 'https://open.feishu.cn/open-apis';

let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * Obtain (or return cached) tenant access token.
 */
async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const resp = await axios.post(`${BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });

  if (resp.data.code !== 0) {
    throw new Error(`Failed to get tenant token: ${resp.data.msg}`);
  }

  cachedToken = resp.data.tenant_access_token as string;
  // expire 5 minutes early to be safe (token TTL is typically 7200 s)
  tokenExpiry = Date.now() + (resp.data.expire - 300) * 1000;
  return cachedToken;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Send a plain-text message to a group chat.
 * Returns the Feishu message_id of the sent message.
 */
export async function sendMessage(chatId: string, text: string): Promise<string> {
  const token = await getTenantToken();
  const resp = await axios.post(
    `${BASE}/im/v1/messages?receive_id_type=chat_id`,
    {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    { headers: authHeader(token) }
  );
  return (resp.data?.data?.message_id as string) ?? '';
}

/**
 * Reply to a message and create (or continue) a Feishu thread (话题).
 * Returns the new message_id and the thread_id of the created/continued thread.
 */
export async function replyInThread(
  messageId: string,
  text: string,
): Promise<{ messageId: string; threadId: string }> {
  const token = await getTenantToken();
  const resp = await axios.post(
    `${BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    {
      msg_type: 'text',
      content: JSON.stringify({ text }),
      reply_in_thread: true,
    },
    { headers: authHeader(token) }
  );
  // Feishu reply API returns the new message at resp.data.data (not nested under .message)
  const d = resp.data?.data ?? {};
  return {
    messageId: (d.message_id as string) ?? '',
    threadId: (d.thread_id as string) ?? '',
  };
}

/**
 * Send a plain-text message into an existing Feishu thread by replying
 * to the thread's anchor message (receive_id_type=thread_id is not supported).
 * anchorMsgId: the message_id of the message that originally created the thread.
 * Returns the new message_id.
 */
export async function sendToThread(anchorMsgId: string, text: string): Promise<string> {
  const result = await replyInThread(anchorMsgId, text);
  return result.messageId;
}

/**
 * Update the name (title) of a Feishu thread (话题).
 * Fails gracefully — logs the error but does not throw.
 */
export async function updateThreadName(threadId: string, name: string): Promise<void> {
  try {
    const token = await getTenantToken();
    await axios.patch(
      `${BASE}/im/v1/threads/${encodeURIComponent(threadId)}`,
      { name },
      { headers: authHeader(token) }
    );
  } catch (err) {
    console.warn('[updateThreadName] failed (non-fatal):', (err as Error).message);
  }
}

/**
 * Edit (replace) the content of an existing plain-text message.
 * Fails gracefully — logs the error but does not throw.
 */
export async function editMessage(msgId: string, text: string): Promise<void> {
  try {
    const token = await getTenantToken();
    await axios.put(
      `${BASE}/im/v1/messages/${encodeURIComponent(msgId)}`,
      { msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: authHeader(token) }
    );
  } catch (err) {
    const axiosErr = err as { response?: { data?: { code?: number; msg?: string } } };
    const code = axiosErr.response?.data?.code;
    const msg = axiosErr.response?.data?.msg ?? (err as Error).message;
    console.warn(`[editMessage] failed (non-fatal): code=${code} ${msg}`);
  }
}

/**
 * Rename a group chat.
 */
export async function renameChat(chatId: string, name: string): Promise<void> {
  const token = await getTenantToken();
  await axios.put(
    `${BASE}/im/v1/chats/${chatId}`,
    { name },
    { headers: authHeader(token) }
  );
}

/**
 * Fetch user info (display_name) by open_id.
 */
export async function getUserName(openId: string): Promise<string> {
  const token = await getTenantToken();
  const resp = await axios.get(
    `${BASE}/contact/v3/users/${openId}?user_id_type=open_id`,
    { headers: authHeader(token) }
  );
  return resp.data?.data?.user?.name ?? openId;
}

/**
 * Add an emoji reaction to a message. Fails gracefully.
 * emojiType: e.g. "Get" (了解), "THUMBSUP", "OK"
 */
export async function addReaction(messageId: string, emojiType = 'Get'): Promise<void> {
  try {
    const token = await getTenantToken();
    await axios.post(
      `${BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { reaction_type: { emoji_type: emojiType } },
      { headers: authHeader(token) }
    );
  } catch (err) {
    const axiosErr = err as { response?: { data?: { code?: number; msg?: string } } };
    const code = axiosErr.response?.data?.code;
    const msg = axiosErr.response?.data?.msg ?? (err as Error).message;
    console.warn(`[addReaction] failed (non-fatal): code=${code} ${msg}`);
  }
}
