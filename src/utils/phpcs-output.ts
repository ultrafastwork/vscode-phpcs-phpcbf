import type { PHPCSReport } from '../interfaces/phpcs-report';

/**
 * PHP_CodeSniffer 4.x exit codes. They are bit flags and can be combined,
 * e.g. `3` = auto-fixable + non-auto-fixable issues remaining.
 *
 * @see https://github.com/PHPCSStandards/PHP_CodeSniffer/wiki/Usage#understanding-the-exit-codes
 */
export const PHPCSExitCode = {
  /** Auto-fixable issues found / remaining. */
  FIXABLE: 1,
  /** Non-auto-fixable issues found / remaining. */
  NON_FIXABLE: 2,
  /** PHPCBF failed to fix some of the fixable issues (e.g. a fixer conflict). */
  FIXER_FAILED: 4,
  /** A processing error occurred. */
  PROCESSING_ERROR: 16,
  /** Requirements for running PHPCS/PHPCBF were not met. */
  REQUIREMENTS_NOT_MET: 64,
} as const;

/**
 * Mask of every flag that only reports on the code being checked,
 * rather than a failure of PHPCS itself.
 */
const ISSUE_FLAGS =
  PHPCSExitCode.FIXABLE |
  PHPCSExitCode.NON_FIXABLE |
  PHPCSExitCode.FIXER_FAILED;

/**
 * Whether an exit code means the tool ran successfully (with or without issues),
 * i.e. it is any combination of 0, 1, 2 and 4.
 * @param {number | null} exitCode The process exit code.
 * @returns {boolean} `true` if the run completed normally.
 */
export const isCompletedExitCode = (exitCode: number | null): boolean =>
  exitCode !== null && exitCode >= 0 && (exitCode & ~ISSUE_FLAGS) === 0;

/**
 * Describe an exit code that signals a failure of PHPCS/PHPCBF itself.
 * @param {'PHPCS' | 'PHPCBF'} tool The tool that returned the code.
 * @param {number | null} exitCode The process exit code.
 * @returns {string} A human-readable description.
 */
export const describeFailureExitCode = (
  tool: 'PHPCS' | 'PHPCBF',
  exitCode: number | null,
): string => {
  if (exitCode === null) {
    return `${tool}: The process was terminated before it finished.`;
  }
  if (exitCode >= 0 && exitCode & PHPCSExitCode.REQUIREMENTS_NOT_MET) {
    return `${tool}: Requirements for running not met (exit code ${exitCode}).`;
  }
  if (exitCode >= 0 && exitCode & PHPCSExitCode.PROCESSING_ERROR) {
    return `${tool}: A processing error occurred (exit code ${exitCode}).`;
  }
  return `${tool}: An unknown error occurred (exit code ${exitCode}).`;
};

/**
 * Parse the output of `phpcs --report=json`.
 *
 * PHP may print notices or deprecation messages to stdout before the report
 * (e.g. when `display_errors` is on), so the parser looks for the start of the
 * JSON report instead of requiring the whole output to be JSON.
 *
 * @param {string} stdout The raw stdout of PHPCS.
 * @returns {PHPCSReport | null} The report, or `null` if no valid report was found.
 */
export const parsePhpcsJsonReport = (stdout: string): PHPCSReport | null => {
  const start = stdout.search(/\{\s*"totals"\s*:/);
  if (start === -1) {
    return null;
  }

  try {
    const report = JSON.parse(stdout.slice(start).trim()) as PHPCSReport;
    if (typeof report !== 'object' || report === null || !report.files) {
      return null;
    }
    return report;
  } catch {
    return null;
  }
};
