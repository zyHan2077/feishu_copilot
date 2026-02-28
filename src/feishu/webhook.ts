import crypto from 'crypto';
import { Request, Response } from 'express';
import { routeMessage } from '../bot/router';

/**
 * Decrypt AES-256-CBC encrypted Feishu event body.
 * Key = first 32 bytes of SHA256(encryptKey)
 * Payload = base64(iv[16] + ciphertext)
 */
function decryptBody(encrypted: string, encryptKey: string): Record<string, unknown> {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.slice(0, 16);
  const content = buf.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(content), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>;
}

/**
 * Verify X-Lark-Signature for incoming webhook events.
 * https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-instruction
 */
function verifySignature(req: Request, decryptedBody?: Record<string, unknown>): boolean {
  const token = process.env.FEISHU_VERIFICATION_TOKEN ?? '';
  // Simple token-based check (non-encrypted mode)
  // v1: token is in body.token; v2.0: token is in body.header.token
  // When body was encrypted, check the decrypted body's token instead of the raw encrypted body.
  const body = (decryptedBody ?? req.body) as Record<string, unknown>;
  const header = body?.header as Record<string, unknown> | undefined;
  if (body?.token === token || header?.token === token) return true;
  // Encrypted mode: verify HMAC-SHA256 signature header
  const signature = req.headers['x-lark-signature'] as string | undefined;
  if (!signature) return false;
  const timestamp = req.headers['x-lark-request-timestamp'] as string ?? '';
  const nonce = req.headers['x-lark-request-nonce'] as string ?? '';
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf-8') ?? JSON.stringify(req.body);
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY ?? '';
  const computed = crypto
    .createHmac('sha256', encryptKey)
    .update(`${timestamp}${nonce}${rawBody}`)
    .digest('hex');
  return computed === signature;
}

/**
 * Express handler for POST /webhook/event
 */
export async function webhookHandler(req: Request, res: Response): Promise<void> {
  let body = req.body as Record<string, unknown>;

  // Decrypt if Feishu encryption is enabled
  if (typeof body?.encrypt === 'string') {
    const encryptKey = process.env.FEISHU_ENCRYPT_KEY ?? '';
    try {
      body = decryptBody(body.encrypt as string, encryptKey);
    } catch (e) {
      console.error('[webhook] decryption failed:', e);
      res.status(400).json({ error: 'decryption failed' });
      return;
    }
  }

  console.log('[webhook] body:', JSON.stringify(body));

  // URL verification challenge (first-time setup)
  // v1: { type: 'url_verification', challenge: '...' }
  // v2: { schema: '2.0', header: { event_type: 'url_verification' }, event: { challenge: '...' } }
  const header = body?.header as Record<string, unknown> | undefined;
  if (body?.type === 'url_verification') {
    res.json({ challenge: body.challenge });
    return;
  }
  if (header?.event_type === 'url_verification') {
    const challenge = (body?.event as Record<string, unknown>)?.challenge;
    res.json({ challenge });
    return;
  }

  if (!verifySignature(req, body)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  // Acknowledge immediately to avoid Feishu retry
  res.json({ code: 0 });

  // Process asynchronously
  setImmediate(() => handleEvent(body).catch(console.error));
}

/** Parse and dispatch a verified event. */
async function handleEvent(body: Record<string, unknown>): Promise<void> {
  const event = (body?.event ?? body) as Record<string, unknown>;
  const header = body?.header as Record<string, unknown> | undefined;
  const bodyEvent = body?.event as Record<string, unknown> | undefined;
  const eventType: string = (header?.event_type as string) ?? (bodyEvent?.type as string) ?? '';

  // Bot added to group → send init prompt
  if (eventType === 'im.chat.member.bot.added_v1') {
    const chatId: string = (event?.chat_id as string) ?? '';
    if (chatId) {
      const { sendInitPrompt, isInitialized } = await import('../bot/init');
      if (!isInitialized(chatId)) await sendInitPrompt(chatId);
    }
    return;
  }

  // Only handle incoming messages
  if (eventType !== 'im.message.receive_v1' && eventType !== 'message') return;

  const msg = event?.message as Record<string, unknown> | undefined;
  const sender = event?.sender as Record<string, unknown> | undefined;
  if (!msg || !sender) return;

  const chatType: string = (msg.chat_type as string) ?? '';
  const chatId: string = (msg.chat_id as string) ?? '';
  const senderId: string = (sender.sender_id as Record<string, string>)?.open_id ?? '';
  const msgType: string = (msg.message_type as string) ?? '';

  // Ignore private/direct messages
  if (chatType !== 'group') return;

  // Only handle text messages that mention the bot
  if (msgType !== 'text') return;

  let rawContent = '';
  try {
    rawContent = JSON.parse(msg.content as string)?.text ?? '';
  } catch {
    return;
  }

  // Extract text after @mention (Feishu injects @_user_xxx placeholders)
  // Pattern: "@_user_1 some text" or "<at user_id=...>name</at> some text"
  const text = rawContent
    .replace(/@\S+/g, '')
    .replace(/<at[^>]*>[^<]*<\/at>/g, '')
    .trim();

  await routeMessage({ chatId, senderId, text, rawContent });
}
