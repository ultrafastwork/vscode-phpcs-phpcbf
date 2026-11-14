import {
  type CancellationToken,
  CancellationTokenSource,
  type ConfigurationChangeEvent,
  Diagnostic,
  type DiagnosticCollection,
  DiagnosticSeverity,
  type Disposable,
  languages,
  Position,
  Range,
  type TextDocument,
  type TextDocumentChangeEvent,
  window,
  workspace,
} from 'vscode';
import {
  type PHPCSMessage,
  PHPCSMessageType,
  type PHPCSReport,
} from './interfaces/phpcs-report';
import type { ResourceSettings, Settings } from './interfaces/settings';
import { logger } from './logger';
import { createStandardsPathResolver } from './resolvers/standards-path-resolver';
import { getResourceSettingsFor, getSettings } from './settings';
import {
  determineNodeError,
  getPhpNotFoundRegex,
} from './utils/error-handling/error-helpers';
import { debounce, getArgs, shouldProcess } from './utils/helpers';
import {
  describeFailureExitCode,
  parsePhpcsJsonReport,
} from './utils/phpcs-output';
import {
  describeCommand,
  type RunCommandResult,
  runCommand,
} from './utils/process-runner';

/**
 * Kill PHPCS if it takes longer than this.
 */
const SNIFFER_TIMEOUT_MS = 60_000;

const diagnosticCollection: DiagnosticCollection =
  languages.createDiagnosticCollection('php');

/**
 * The active validator listener.
 */
let validatorListener: Disposable | undefined;

/**
 * Tokens to cancel in-flight validation runs, keyed by document URI string.
 */
const runnerCancellations: Map<string, CancellationTokenSource> = new Map();

/**
 * Validates and lints a document. Starting a new run for a document cancels
 * (and kills) any run still in progress for the same document.
 *
 * @param document - The document to lint.
 * @returns {Promise<void>} A void promise that resolves once the validation is complete.
 */
const validate = async (document: TextDocument): Promise<void> => {
  const settings = await getSettings();
  const resourceConf = getResourceSettingsFor(settings, document.uri);

  // If the document should not be processed, return early.
  if (!resourceConf || !shouldProcess(document, resourceConf, 'sniffer')) {
    return;
  }

  const key = document.uri.toString();
  const oldRunner = runnerCancellations.get(key);
  if (oldRunner) {
    oldRunner.cancel();
    oldRunner.dispose();
  }

  const runner = new CancellationTokenSource();
  runnerCancellations.set(key, runner);

  try {
    await runSniffer(document, settings, resourceConf, runner.token);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`SNIFFER: ${message}`);
  } finally {
    if (runnerCancellations.get(key) === runner) {
      runnerCancellations.delete(key);
    }
    runner.dispose();
  }
};

/**
 * Run PHPCS on a document and publish the resulting diagnostics.
 * @param {TextDocument} document The document to lint.
 * @param {Settings} settings The extension settings.
 * @param {ResourceSettings} resourceConf The settings of the document's workspace folder.
 * @param {CancellationToken} token Cancels the run.
 */
const runSniffer = async (
  document: TextDocument,
  settings: Settings,
  resourceConf: ResourceSettings,
  token: CancellationToken,
): Promise<void> => {
  let standard: string;

  try {
    standard = await createStandardsPathResolver(
      document,
      resourceConf,
    ).resolve();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    window.showErrorMessage(errorMessage, 'OK');
    logger.error(errorMessage);
    return;
  }

  if (token.isCancellationRequested) {
    return;
  }

  const lintArgs = getArgs(
    document.fileName,
    standard,
    resourceConf.snifferArguments,
    'sniffer',
  );
  const executable = resourceConf.executablePathCS;

  logger.info(`SNIFFER COMMAND: ${describeCommand(executable, lintArgs)}`);
  logger.startTimer('Sniffer');

  const run = runCommand(executable, lintArgs, {
    cwd: resourceConf.workspaceRoot ?? undefined,
    input: document.getText(),
    timeout: SNIFFER_TIMEOUT_MS,
    token,
  });
  window.setStatusBarMessage('PHP Code Sniffer: validating…', run);

  const result = await run;
  logger.endTimer('Sniffer');

  // A newer run replaced this one; it will publish the diagnostics.
  if (result.cancelled || token.isCancellationRequested) {
    logger.info('SNIFFER: Run cancelled.');
    return;
  }

  logger.info(`SNIFFER EXIT CODE: ${result.exitCode}`);
  if (result.stderr) {
    logger.error(`SNIFFER STDERR: ${result.stderr.trim()}`);
  }

  const report = result.error ? null : parsePhpcsJsonReport(result.stdout);

  if (!report) {
    reportSnifferFailure(result);
    return;
  }

  diagnosticCollection.set(
    document.uri,
    buildDiagnostics(document, report, settings),
  );
};

/**
 * Tell the user why PHPCS did not produce a report.
 * @param result The result of the PHPCS process.
 */
const reportSnifferFailure = (result: RunCommandResult): void => {
  let errorMsg: string;
  let extraLoggerMsg = '';

  if (result.error) {
    ({ errorMsg, extraLoggerMsg } = determineNodeError(
      result.error,
      'sniffer',
    ));
  } else if (getPhpNotFoundRegex().test(result.stderr)) {
    errorMsg = `Please add PHP to your system's environment path, or use the extension setting "phpExecutablePath". - PHPCS error: ${result.stderr.trim()}`;
  } else {
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join('\n');
    errorMsg = `${describeFailureExitCode('PHPCS', result.exitCode)} ${
      output || 'PHPCS did not return a report.'
    }`;
  }

  logger.error(`${errorMsg}${extraLoggerMsg}`);
  window.showErrorMessage(errorMsg, 'OK');
};

/**
 * Convert a PHPCS report into VS Code diagnostics.
 * @param {TextDocument} document The linted document.
 * @param {PHPCSReport} report The PHPCS JSON report.
 * @param {Settings} settings The extension settings.
 * @returns {Diagnostic[]} The diagnostics.
 */
const buildDiagnostics = (
  document: TextDocument,
  report: PHPCSReport,
  settings: Settings,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  for (const file of Object.values(report.files)) {
    for (const message of file.messages) {
      diagnostics.push(toDiagnostic(document, message, settings));
    }
  }

  return diagnostics;
};

/**
 * Convert a single PHPCS message into a diagnostic.
 * @param {TextDocument} document The linted document.
 * @param {PHPCSMessage} message The PHPCS message.
 * @param {Settings} settings The extension settings.
 * @returns {Diagnostic} The diagnostic.
 */
const toDiagnostic = (
  document: TextDocument,
  { message, line, column, type, source, fixable }: PHPCSMessage,
  settings: Settings,
): Diagnostic => {
  // PHPCS is 1-based; clamp in case the document changed while PHPCS was running.
  const zeroLine = Math.min(Math.max(line - 1, 0), document.lineCount - 1);
  const lineLength = document.lineAt(zeroLine).text.length;
  const zeroColumn = Math.min(Math.max(column - 1, 0), lineLength);
  const position = new Position(zeroLine, zeroColumn);

  // Highlight the word the message points at, if there is one.
  const range =
    document.getWordRangeAtPosition(position) ?? new Range(position, position);

  const severity =
    type === PHPCSMessageType.ERROR
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning;

  let output = message;
  if (settings.snifferShowFixabilityIcons) {
    output += `\nAuto-fixable: ${fixable ? '✔️' : '❌'}`;
  }

  const diagnostic = new Diagnostic(range, output, severity);
  diagnostic.source = 'phpcs';
  if (settings.snifferShowSources) {
    diagnostic.code = source;
  }

  return diagnostic;
};

/**
 * Refreshes validation on any open documents.
 */
export const refreshSniffer = (): void => {
  diagnosticCollection.clear();

  workspace.textDocuments.forEach(validate);
};

/**
 * Clears diagnostics from a document, and stops any run in progress for it.
 *
 * @param {TextDocument} document - The document to clear diagnostics of.
 */
const clearDocumentDiagnostics = ({ uri }: TextDocument): void => {
  runnerCancellations.get(uri.toString())?.cancel();
  diagnosticCollection.delete(uri);
};

/**
 * Sets the validation event listening.
 * @returns {Promise<void>} A void promise that resolves once the validator listener has been set.
 */
const setValidatorListener = async (): Promise<void> => {
  const settings = await getSettings();

  validatorListener?.dispose();

  if (settings.snifferMode === 'onType') {
    const validator = debounce(
      ({ document }: TextDocumentChangeEvent): void => {
        validate(document);
      },
      settings.snifferTypeDelay,
    );
    validatorListener = workspace.onDidChangeTextDocument(validator);
  } else {
    validatorListener = workspace.onDidSaveTextDocument(validate);
  }
};

/**
 * Handle a settings change. Must be called after the settings have been reloaded.
 * Updates the validator listener if necessary, and re-validates open documents.
 *
 * @param {ConfigurationChangeEvent} event The configuration change event.
 */
export const onSnifferSettingsChanged = (
  event: ConfigurationChangeEvent,
): void => {
  if (
    event.affectsConfiguration('phpsab.snifferMode') ||
    event.affectsConfiguration('phpsab.snifferTypeDelay')
  ) {
    setValidatorListener();
  }

  refreshSniffer();
};

/**
 * Dispose Sniffer diagnostics and stop any running PHPCS processes.
 */
export const disposeSniffer = (): void => {
  for (const runner of runnerCancellations.values()) {
    runner.cancel();
    runner.dispose();
  }
  runnerCancellations.clear();
  validatorListener?.dispose();
  diagnosticCollection.clear();
  diagnosticCollection.dispose();
};

/**
 * Activates the Sniffer and register the event listeners.
 * @param {Disposable[]} subscriptions The array of disposables to which the event listeners will be added.
 */
export const activateSniffer = (subscriptions: Disposable[]): void => {
  workspace.onDidOpenTextDocument(validate, null, subscriptions);
  workspace.onDidCloseTextDocument(
    clearDocumentDiagnostics,
    null,
    subscriptions,
  );

  refreshSniffer();
  setValidatorListener();
};
