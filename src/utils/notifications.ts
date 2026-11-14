import { window } from 'vscode';

/**
 * Messages that have already been shown during this session.
 */
const shownMessages = new Set<string>();

/**
 * Show a warning notification only the first time a given message occurs in this
 * session. Use this for conditions that are re-checked often (every save, every
 * settings reload) so the user is told once instead of on every run.
 * The caller is still responsible for logging the message every time.
 *
 * @param {string} message The warning to show.
 */
export const showWarningOnce = (message: string): void => {
  if (shownMessages.has(message)) {
    return;
  }
  shownMessages.add(message);
  window.showWarningMessage(message, 'OK');
};
