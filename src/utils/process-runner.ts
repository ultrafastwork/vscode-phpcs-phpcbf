import { type ChildProcess, spawn } from 'node:child_process';
import type { CancellationToken } from 'vscode';
import type { ConsoleError } from '../interfaces/console-error';
import { isWin } from '../resolvers/path-resolver-utils';
import { addWindowsEnoentError } from './error-handling/windows-enoent-error';
import { constructCommandString, parseArgs } from './helpers';

/**
 * Options for running an external command.
 */
export interface RunCommandOptions {
  /**
   * The working directory of the process.
   */
  cwd?: string;

  /**
   * Text written to the process's stdin. stdin is closed afterwards.
   */
  input?: string;

  /**
   * Kill the process after this many milliseconds.
   */
  timeout?: number;

  /**
   * Kill the process when cancellation is requested.
   */
  token?: CancellationToken;
}

/**
 * The outcome of running an external command.
 */
export interface RunCommandResult {
  stdout: string;
  stderr: string;

  /**
   * The exit code, or `null` if the process was killed or failed to start.
   */
  exitCode: number | null;

  /**
   * A Node error raised while spawning or running the process (e.g. ENOENT, ETIMEDOUT).
   */
  error: ConsoleError | null;

  /**
   * Whether the process was stopped because cancellation was requested.
   */
  cancelled: boolean;
}

/**
 * Build a human-readable command line for logging.
 * @param {string} executable The executable path.
 * @param {string[]} args The raw arguments.
 * @returns {string} The command line.
 */
export const describeCommand = (executable: string, args: string[]): string =>
  constructCommandString(executable, parseArgs(args));

/**
 * Forcefully stop a process. On Windows the command runs through `cmd.exe`,
 * so the whole process tree must be killed, otherwise PHP keeps running.
 * @param {ChildProcess} child The process to stop.
 */
const killProcess = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (isWin() && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }

  child.kill('SIGKILL');
};

/**
 * Run an external command asynchronously, without blocking the extension host.
 *
 * On Windows the command runs through the shell, because `.bat` files (such as
 * Composer's `vendor/bin/phpcs.bat`) cannot be spawned directly.
 * @see https://github.com/nodejs/node/issues/52554
 *
 * Everywhere else the arguments are passed straight to the executable without a
 * shell, so file names can never be interpreted as shell syntax.
 *
 * @param {string} executable The executable path.
 * @param {string[]} args The raw (unquoted) arguments.
 * @param {RunCommandOptions} options The run options.
 * @returns {Promise<RunCommandResult>} The result once the process has exited.
 */
export const runCommand = (
  executable: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> => {
  return new Promise((resolve) => {
    const useShell = isWin();
    let child: ChildProcess;

    try {
      child = useShell
        ? spawn(describeCommand(executable, args), {
            cwd: options.cwd,
            env: process.env,
            shell: true,
            windowsHide: true,
          })
        : spawn(executable, args, {
            cwd: options.cwd,
            env: process.env,
            shell: false,
          });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error as ConsoleError,
        cancelled: false,
      });
      return;
    }

    if (useShell) {
      addWindowsEnoentError(child, { commandPath: executable, args }, 'spawn');
    }

    let stdout = '';
    let stderr = '';
    let error: ConsoleError | null = null;
    let cancelled = false;
    let settled = false;

    const timer =
      options.timeout !== undefined
        ? setTimeout(() => {
            error = Object.assign(
              new Error(
                `${executable} did not finish within ${options.timeout} ms`,
              ),
              { code: 'ETIMEDOUT' },
            );
            killProcess(child);
          }, options.timeout)
        : undefined;

    const cancellation = options.token?.onCancellationRequested(() => {
      cancelled = true;
      killProcess(child);
    });

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancellation?.dispose();
      resolve({ stdout, stderr, exitCode, error, cancelled });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      stdout += data;
    });
    child.stderr?.on('data', (data: string) => {
      stderr += data;
    });

    child.on('error', (err) => {
      // Keep a timeout error, as it explains why the process was killed.
      error ??= err as ConsoleError;
      // If the process never started, 'close' may never be emitted.
      if (child.pid === undefined) {
        settle(null);
      }
    });

    child.on('close', (exitCode) => settle(exitCode));

    if (options.token?.isCancellationRequested) {
      cancelled = true;
      killProcess(child);
    }

    if (child.stdin) {
      // The process may exit before reading all of stdin (EPIPE); the exit code
      // and output still tell us what happened, so ignore the write error.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input ?? '');
    }
  });
};
