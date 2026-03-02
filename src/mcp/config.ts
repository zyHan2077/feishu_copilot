/**
 * Writes ~/.copilot/mcp-config.json with the feishu MCP server entry.
 *
 * writeMcpConfig() is called at /on time (startCopilot) and writes an HTTP URL
 * that includes the chat_id and session_label as query params so the persistent
 * MCP handler can route tool calls to the correct Feishu thread.
 *
 * ensureMcpConfig() is kept for backward compatibility / manual fallback use.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const MCP_CONFIG_PATH = path.join(os.homedir(), '.copilot', 'mcp-config.json');
const PORT = process.env.PORT ?? '8888';

/**
 * Write mcp-config.json pointing to the persistent HTTP MCP endpoint for a specific session.
 * Called by startCopilot() after the session_label is generated.
 */
export function writeMcpConfig(chatId: string, sessionLabel: string): void {
  try {
    fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });

    let config: Record<string, unknown> = {};
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      try {
        config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }

    const encodedChatId = encodeURIComponent(chatId);
    const encodedSession = encodeURIComponent(sessionLabel);
    const url = `http://localhost:${PORT}/mcp?chat_id=${encodedChatId}&session=${encodedSession}`;

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers.feishu = { url };
    config.mcpServers = servers;

    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[mcp/config] wrote MCP config for session ${sessionLabel} (chat: ${chatId})`);
  } catch (e) {
    console.warn('[mcp/config] failed to write MCP config (non-fatal):', (e as Error).message);
  }
}

/**
 * @deprecated Use writeMcpConfig(chatId, sessionLabel) instead.
 * Kept as fallback for manual / pre-session use.
 */
export function ensureMcpConfig(): void {
  const SERVER_SCRIPT = path.join(__dirname, 'server.js');
  try {
    fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });

    let config: Record<string, unknown> = {};
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      try {
        config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const existing = servers.feishu as { command?: string; args?: string[] } | undefined;

    if (existing?.command === 'node' && existing?.args?.[0] === SERVER_SCRIPT) {
      return;
    }

    servers.feishu = { command: 'node', args: [SERVER_SCRIPT] };
    config.mcpServers = servers;

    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[mcp/config] wrote fallback stdio MCP config to ${MCP_CONFIG_PATH}`);
  } catch (e) {
    console.warn('[mcp/config] failed to write MCP config (non-fatal):', (e as Error).message);
  }
}
