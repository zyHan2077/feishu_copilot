import { execSync, spawnSync } from 'child_process';

/**
 * Create a new detached tmux session. No-op if session already exists.
 */
export function createSession(sessionName: string, workdir: string): void {
  const exists = sessionExists(sessionName);
  if (!exists) {
    execSync(`tmux new-session -d -s ${shellEsc(sessionName)} -c ${shellEsc(workdir)}`);
  }
}

/**
 * Kill a tmux session entirely.
 */
export function killSession(sessionName: string): void {
  if (sessionExists(sessionName)) {
    execSync(`tmux kill-session -t ${shellEsc(sessionName)}`);
  }
}

/**
 * Check whether a tmux session with the given name exists.
 */
export function sessionExists(sessionName: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName]);
  return result.status === 0;
}

/**
 * Create a new window inside an existing session.
 * Returns false if a window with that name already exists.
 */
export function createWindow(sessionName: string, windowName: string): boolean {
  if (windowExists(sessionName, windowName)) return false;
  execSync(
    `tmux new-window -t ${shellEsc(sessionName)} -n ${shellEsc(windowName)}`
  );
  return true;
}

/**
 * Check whether a window with the given name exists inside a session.
 */
export function windowExists(sessionName: string, windowName: string): boolean {
  const result = spawnSync('tmux', [
    'list-windows', '-t', sessionName, '-F', '#{window_name}',
  ]);
  if (result.status !== 0) return false;
  const names = (result.stdout?.toString() ?? '').split('\n');
  return names.includes(windowName);
}

/**
 * Kill a window by name inside a session.
 */
export function killWindow(sessionName: string, windowName: string): void {
  if (windowExists(sessionName, windowName)) {
    execSync(`tmux kill-window -t ${shellEsc(sessionName)}:${shellEsc(windowName)}`);
  }
}

/**
 * Send keystrokes to a pane (window name defaults to session base window).
 */
export function sendKeys(sessionName: string, windowName: string, keys: string): void {
  execSync(
    `tmux send-keys -t ${shellEsc(sessionName)}:${shellEsc(windowName)} ${shellEsc(keys)} Enter`
  );
}

/**
 * Capture visible pane content as plain text (ANSI codes stripped).
 * Returns the raw string output.
 */
export function capturePane(sessionName: string, windowName: string): string {
  const result = spawnSync('tmux', [
    'capture-pane', '-t', `${sessionName}:${windowName}`, '-p', '-e',
  ]);
  const raw = result.stdout?.toString() ?? '';
  return stripAnsi(raw);
}

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

/**
 * Single-quote escape a shell argument.
 */
function shellEsc(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
