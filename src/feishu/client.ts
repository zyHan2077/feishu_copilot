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
 */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = await getTenantToken();
  await axios.post(
    `${BASE}/im/v1/messages?receive_id_type=chat_id`,
    {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    { headers: authHeader(token) }
  );
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
