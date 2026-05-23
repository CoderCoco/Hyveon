import fixPath from 'fix-path';

/**
 * Applies the fix-path workaround for GUI applications on macOS and Linux.
 *
 * When an application is launched from a graphical environment (e.g. a dock,
 * file manager, or Electron shell) rather than a terminal, the process does not
 * inherit the user's login shell PATH. This means executables that are only
 * available after sourcing `~/.profile`, `~/.bashrc`, `~/.zshrc`, etc. — such
 * as `node`, `aws`, or any tool installed via nvm/homebrew — will not be found.
 *
 * fix-path resolves this by spawning a login shell, reading its PATH, and
 * applying it to the current process before any child processes are started.
 *
 * This function is a no-op on Windows, where the problem does not apply.
 */
export function applyFixPath(): void {
  if (process.platform === 'win32') {
    return;
  }
  fixPath();
}
