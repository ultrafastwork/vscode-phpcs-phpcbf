import {
  type CancellationToken,
  Position,
  Range,
  type TextDocument,
  TextEdit,
  window,
} from 'vscode';
import { logger } from './logger';
import { createStandardsPathResolver } from './resolvers/standards-path-resolver';
import { getResourceSettingsFor, getSettings } from './settings';
import {
  determineNodeError,
  getPhpNotFoundRegex,
} from './utils/error-handling/error-helpers';
import { getArgs, shouldProcess } from './utils/helpers';
import {
  describeFailureExitCode,
  isCompletedExitCode,
  PHPCSExitCode,
} from './utils/phpcs-output';
import { describeCommand, runCommand } from './utils/process-runner';

/**
 * Kill PHPCBF if it takes longer than this.
 */
const FIXER_TIMEOUT_MS = 60_000;

/**
 * How long fixer status messages stay in the status bar.
 */
const STATUS_MESSAGE_MS = 4_000;

/**
 * Get the document range
 * @param {TextDocument} document TextDocument
 * @returns {Range} The full range of the document.
 */
const documentFullRange = (document: TextDocument) =>
  new Range(
    new Position(0, 0),
    document.lineAt(document.lineCount - 1).range.end,
  );

/**
 * Run the fixer process on a document.
 * @param {TextDocument} document The text document to format.
 * @param {CancellationToken} token Cancels the run.
 * @returns {Promise<string | null>} The fixed document text, or `null` if there is nothing to change.
 * @throws {Error} If PHPCBF could not be run or failed.
 */
const format = async (
  document: TextDocument,
  token: CancellationToken,
): Promise<string | null> => {
  const settings = await getSettings();
  const resourceConf = getResourceSettingsFor(settings, document.uri);

  // If the document should not be processed, return early.
  if (!resourceConf || !shouldProcess(document, resourceConf, 'fixer')) {
    // Only show information dialog if fixer is disabled.
    // (We don't want to spam users if it's not a PHP file or if it's excluded via glob patterns.)
    if (resourceConf?.fixerEnable === false) {
      window.showInformationMessage(
        'Fixer is disabled for this workspace or PHPCBF was not found for this workspace.',
      );
    }
    return null;
  }

  const standard = await createStandardsPathResolver(
    document,
    resourceConf,
  ).resolve();

  if (token.isCancellationRequested) {
    return null;
  }

  const fixerArgs = getArgs(
    document.fileName,
    standard,
    resourceConf.fixerArguments,
    'fixer',
  );
  const executable = resourceConf.executablePathCBF;
  const fileText = document.getText();
  const version = document.version;

  logger.info(`FIXER COMMAND: ${describeCommand(executable, fixerArgs)}`);
  logger.startTimer('Fixer');

  const run = runCommand(executable, fixerArgs, {
    cwd: resourceConf.workspaceRoot ?? undefined,
    input: fileText,
    timeout: FIXER_TIMEOUT_MS,
    token,
  });
  window.setStatusBarMessage('PHP Code Beautifier: fixing…', run);

  const { stdout, stderr, exitCode, error, cancelled } = await run;
  logger.endTimer('Fixer');

  if (cancelled || token.isCancellationRequested) {
    logger.info('FIXER: Run cancelled.');
    return null;
  }

  logger.info(`FIXER EXIT CODE: ${exitCode}`);
  if (stderr) {
    logger.error(`FIXER STDERR: ${stderr.trim()}`);
  }

  if (error) {
    const { errorMsg, extraLoggerMsg } = determineNodeError(error, 'fixer');
    // The message itself is logged by provideFixerEdits; log the details here.
    logger.error(`FIXER NODE ERROR DETAILS: ${extraLoggerMsg}`);
    throw new Error(errorMsg);
  }

  // "php is not recognized" or equivalent: PHP is not on the system's environment path.
  if (getPhpNotFoundRegex().test(stderr)) {
    throw new Error(
      `Please add PHP to your system's environment path, or use the extension setting "phpExecutablePath". - PHPCBF error: ${stderr.trim()}`,
    );
  }

  /**
   * PHPCBF 4.x exit codes are bit flags, any combination of:
   * 0  = clean / all fixable issues fixed with no issues remaining
   * 1  = auto-fixable issues remaining
   * 2  = non-auto-fixable issues remaining
   * 4  = fixer conflict / failed to fix some issues
   * Anything else (16 = processing error, 64 = requirements not met) is a failure.
   */
  if (!isCompletedExitCode(exitCode)) {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    throw new Error(
      `${describeFailureExitCode('PHPCBF', exitCode)}${output ? `\n${output}` : ''}`,
    );
  }

  if (document.version !== version) {
    logger.info('FIXER: Document changed while fixing; discarding result.');
    return null;
  }

  if (!hasValidFixedOutput(stdout, fileText)) {
    logger.info('FIXER MESSAGE: No fixable issues were found.');
    window.setStatusBarMessage(
      'PHPCBF: No fixable issues were found.',
      STATUS_MESSAGE_MS,
    );
    return null;
  }

  // exitCode is non-null here, as isCompletedExitCode(null) is false.
  const code = exitCode as number;
  let message = 'PHPCBF: Fixes applied.';
  if (code & PHPCSExitCode.FIXER_FAILED) {
    message = 'PHPCBF: Some fixes applied, but some issues could not be fixed.';
  } else if (code & (PHPCSExitCode.FIXABLE | PHPCSExitCode.NON_FIXABLE)) {
    message = 'PHPCBF: Fixes applied (some issues remain).';
  }

  logger.info(`FIXER MESSAGE: ${message}`);
  window.setStatusBarMessage(message, STATUS_MESSAGE_MS);

  return stdout;
};

/**
 * Check if the fixer output represents successfully fixed code,
 * i.e. it is non-empty and different from the input file text.
 *
 * @param {string} stdout The raw stdout of PHPCBF
 * @param {string} originalFileText The original file text
 * @returns {boolean} boolean indicating if fixes were successfully applied
 */
const hasValidFixedOutput = (
  stdout: string,
  originalFileText: string,
): boolean => {
  return stdout.length > 0 && stdout !== originalFileText;
};

/**
 * Provide the formatting edits for a document. Errors are reported to the user
 * here, once, and result in no edits.
 * @param {TextDocument} document The text document to format.
 * @param {CancellationToken} token Cancels the run.
 * @returns {Promise<TextEdit[]>} The text edits to apply to the document.
 */
export const provideFixerEdits = async (
  document: TextDocument,
  token: CancellationToken,
): Promise<TextEdit[]> => {
  logger.info(`Starting to format the document: ${document.fileName}`);

  try {
    const fixed = await format(document, token);
    return fixed === null
      ? []
      : [TextEdit.replace(documentFullRange(document), fixed)];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    window.showErrorMessage(message, 'OK');
    return [];
  }
};
