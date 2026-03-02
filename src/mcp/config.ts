/**
 * MCP config helpers — write the static feishu HTTP MCP entry to the config files
 * used by Copilot CLI (~/.copilot/mcp-config.json) and Claude Code (~/.claude.json).
 *
 * Both tools read `mcpServers` at the root of their respective JSON config files.
 * Routing to the active Feishu thread is handled at call time via setActiveRoute()
 * in active-route.ts — no session info is embedded in the URL.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const COPILOT_MCP_PATH = path.join(os.homedir(), '.copilot', 'mcp-config.json');
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
const PORT = process.env.PORT ?? '8888';
const STATIC_URL = `http://localhost:${PORT}/mcp`;

/**
 * Idempotently upsert `mcpServers.feishu` with the static HTTP entry in a JSON config file.
 * Creates the file (and parent dirs) if missing. No-op if already set correctly.
 */
function upsertFeishuEntry(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // file missing or corrupt — start fresh
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if ((servers.feishu as { url?: string } | undefined)?.url === STATIC_URL) return;
  servers.feishu = { type: 'http', url: STATIC_URL };
  config.mcpServers = servers;
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[mcp/config] wrote feishu MCP entry to ${filePath}`);
}

/** Write/update the Copilot CLI MCP config (~/.copilot/mcp-config.json). */
export function writeMcpConfig(): void {
  try {
    upsertFeishuEntry(COPILOT_MCP_PATH);
  } catch (e) {
    console.warn('[mcp/config] failed to write Copilot MCP config (non-fatal):', (e as Error).message);
  }
}

/** Write/update the Claude Code MCP config (~/.claude.json). */
export function writeClaudeMcpConfig(): void {
  try {
    upsertFeishuEntry(CLAUDE_JSON_PATH);
  } catch (e) {
    console.warn('[mcp/config] failed to write Claude MCP config (non-fatal):', (e as Error).message);
  }
}

