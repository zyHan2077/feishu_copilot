/**
 * Feishu MCP Server — exposes a `send_feishu_image` tool to GitHub Copilot CLI.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (no SDK dependency).
 * Launched by Copilot CLI as a subprocess; stdin/stdout carry JSON-RPC messages.
 *
 * Environment (inherited from the tmux session via `tmux setenv`):
 *   FEISHU_WORKDIR  — absolute path to the project workdir; used to locate the state file.
 *   FEISHU_APP_ID / FEISHU_APP_SECRET — Feishu credentials (loaded from .env at server root).
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import dotenv from 'dotenv';

// Load .env from the feishu_copilot project root (sibling of dist/).
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { uploadImage, sendImageToThread, sendToThread } from '../feishu/client';
import { loadState } from '../state/store';

// ─── MCP JSON-RPC helpers ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(obj: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id: string | number | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function err(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── Tool: send_feishu_image ──────────────────────────────────────────────────

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

async function handleSendFeishuImage(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const workdir = process.env.FEISHU_WORKDIR;
  if (!workdir) {
    throw new Error(
      'FEISHU_WORKDIR is not set.\n' +
      'Please run the following command in your shell before starting copilot:\n' +
      '  export FEISHU_WORKDIR=/path/to/your/project\n' +
      'Or ask the Feishu bot to start the session via /on so it sets the variable automatically.'
    );
  }

  const state = loadState(workdir);
  if (!state) {
    throw new Error(`No state file found in ${workdir}`);
  }

  const session = state.sessions.find((s) => s.is_running);
  if (!session?.anchor_msg_id) {
    throw new Error('No active Copilot session found in state.');
  }

  let filePath = args.file_path as string;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(workdir, filePath);
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

// ─── MCP request dispatcher ───────────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'feishu', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // No response needed for notifications.
    return;
  }

  if (method === 'tools/list') {
    ok(id, { tools: [TOOL_DEF] });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === 'send_feishu_image') {
      try {
        const result = await handleSendFeishuImage(toolArgs);
        ok(id, result);
      } catch (e) {
        ok(id, {
          content: [{ type: 'text', text: `❌ Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
      return;
    }

    err(id, -32601, `Unknown tool: ${toolName}`);
    return;
  }

  err(id, -32601, `Method not found: ${method}`);
}

// ─── Main: read JSON-RPC messages line by line from stdin ─────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handleRequest(req).catch((e) => {
    console.error('[mcp/server] unhandled error:', e);
  });
});
