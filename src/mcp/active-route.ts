/**
 * In-memory active route for MCP tool calls.
 *
 * Before spawning each `claude -p` subprocess, forwardToClaude() calls setActiveRoute()
 * so the MCP handler knows which Feishu thread to target — without embedding session
 * info in the static MCP URL.
 */

let activeChatId = '';
let activeSessionLabel = '';

export function setActiveRoute(chatId: string, sessionLabel: string): void {
  activeChatId = chatId;
  activeSessionLabel = sessionLabel;
}

export function getActiveRoute(): { chatId: string; sessionLabel: string } {
  return { chatId: activeChatId, sessionLabel: activeSessionLabel };
}
