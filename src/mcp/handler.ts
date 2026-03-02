/**
 * Persistent HTTP MCP handler — exposes `send_feishu_image` over MCP streamable HTTP.
 *
 * Mounted at POST /mcp by the main Express server.
 * Target thread is resolved from query params:
 *   ?chat_id=<chat_id>&session=<session_label>
 *
 * This avoids spawning a per-session MCP subprocess and eliminates the need
 * for FEISHU_WORKDIR env var propagation.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getStateByChatId } from '../state/store';
import { uploadImage, sendImageToThread, sendToThread } from '../feishu/client';
import { getActiveRoute } from './active-route';

const router = Router();

// ─── Tool definition ──────────────────────────────────────────────────────────

const TOOL_DEF = {
  name: 'send_feishu_image',
  description:
    'Upload a local image file and send it to the active Feishu conversation thread. ' +
    'file_path may be absolute or relative to the project workdir.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workdir-relative path to the image file (png, jpg, gif, etc.)',
      },
      caption: {
        type: 'string',
        description: 'Optional text caption to send immediately after the image.',
      },
    },
    required: ['file_path'],
  },
};

// ─── Tool implementation ──────────────────────────────────────────────────────

async function handleSendFeishuImage(
  args: Record<string, unknown>,
  chatId: string,
  sessionLabel: string,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const state = getStateByChatId(chatId);
  if (!state) {
    throw new Error(`No state found for chat_id: ${chatId}`);
  }

  // Find the specific session by label, or fall back to any running session.
  const session =
    state.sessions.find((s) => s.session_label === sessionLabel) ??
    state.sessions.find((s) => s.is_running);

  if (!session?.anchor_msg_id) {
    throw new Error('No active Copilot session found in state.');
  }

  let filePath = args.file_path as string;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(state.workdir, filePath);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const imageKey = await uploadImage(filePath);
  await sendImageToThread(session.anchor_msg_id, imageKey);

  const caption = args.caption as string | undefined;
  if (caption?.trim()) {
    await sendToThread(session.anchor_msg_id, caption.trim());
  }

  return {
    content: [
      {
        type: 'text',
        text: `✅ Image sent to Feishu thread (image_key: ${imageKey})${caption ? ' with caption' : ''}.`,
      },
    ],
  };
}

// ─── MCP JSON-RPC dispatcher ──────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<void> => {
  // URL params are optional — fall back to the in-memory active route set by forwardToClaude()
  const route = getActiveRoute();
  const chatId = (req.query.chat_id as string) || route.chatId;
  const sessionLabel = (req.query.session as string) || route.sessionLabel;

  const body = req.body as { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> };

  const { id, method, params } = body;

  const ok = (result: unknown) => res.json({ jsonrpc: '2.0', id: id ?? null, result });
  const err = (code: number, message: string) =>
    res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (method === 'initialize') {
    ok({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'feishu', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Notifications require no response; send 202.
    res.status(202).end();
    return;
  }

  if (method === 'tools/list') {
    ok({ tools: [TOOL_DEF] });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === 'send_feishu_image') {
      try {
        const result = await handleSendFeishuImage(toolArgs, chatId, sessionLabel);
        ok(result);
      } catch (e) {
        ok({
          content: [{ type: 'text', text: `❌ Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
      return;
    }

    err(-32601, `Unknown tool: ${toolName}`);
    return;
  }

  err(-32601, `Method not found: ${method}`);
});

export { router as mcpRouter };
