import fs from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from './interfaces/settings';
import { logger } from './logger';
import { showWarningOnce } from './utils/notifications';
import { runCommand } from './utils/process-runner';

/**
 * The minimum supported PHP_CodeSniffer major version.
 */
const MINIMUM_MAJOR_VERSION = 4;

/**
 * How long to wait for `--version` before giving up.
 */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Detected versions, keyed by executable path. The modification time is stored
 * so that an upgraded executable is detected again.
 */
const versionCache = new Map<
  string,
  { mtimeMs: number; version: Promise<string | null> }
>();

/**
 * Check PHPCS version compatibility and warn on unsupported versions.
 * @param {Settings} settings The extension settings
 * @return {Promise<void>}
 */
export const checkPhpcsVersionCompatibility = async (
  settings: Settings,
): Promise<void> => {
  await Promise.all(
    settings.resources.map(async (resourceSettings) => {
      const resourceRoot = path.basename(resourceSettings.workspaceRoot || '');
      const cwd = resourceSettings.workspaceRoot ?? undefined;

      // Only check the executables of enabled tools.
      const [phpcsVersion, phpcbfVersion] = await Promise.all([
        resourceSettings.snifferEnable && resourceSettings.executablePathCS
          ? getPhpcsVersion(resourceSettings.executablePathCS, 'PHPCS', cwd)
          : null,
        resourceSettings.fixerEnable && resourceSettings.executablePathCBF
          ? getPhpcsVersion(resourceSettings.executablePathCBF, 'PHPCBF', cwd)
          : null,
      ]);

      let warningMsg = '';

      // If neither version could be determined AND sniffer and fixer are enabled, warn the user.
      if (
        !phpcsVersion &&
        !phpcbfVersion &&
        resourceSettings.snifferEnable &&
        resourceSettings.fixerEnable
      ) {
        warningMsg = `Could not determine version of PHPCS/PHPCBF from "${resourceRoot}". Please ensure the executables are working correctly.`;
      }
      // If PHPCS version could not be determined AND sniffer is enabled, warn the user.
      else if (!phpcsVersion && resourceSettings.snifferEnable) {
        warningMsg = `Could not determine version of PHPCS from "${resourceRoot}". Please ensure the executable is working correctly.`;
      }
      // If PHPCBF version could not be determined AND fixer is enabled, warn the user.
      else if (!phpcbfVersion && resourceSettings.fixerEnable) {
        warningMsg = `Could not determine version of PHPCBF from "${resourceRoot}". Please ensure the executable is working correctly.`;
      }
      // Check for version mismatches when both versions are available
      else if (
        phpcsVersion &&
        phpcbfVersion &&
        phpcsVersion !== phpcbfVersion
      ) {
        warningMsg = `Version mismatch detected: PHPCS version ${phpcsVersion} and PHPCBF version ${phpcbfVersion} from "${resourceRoot}". This may lead to unexpected behavior. Please ensure both are from the same installation directory.`;
      }
      // Check for unsupported versions
      else if (checkUnsupportedVersion(phpcsVersion, phpcbfVersion)) {
        const version = phpcsVersion || phpcbfVersion;
        warningMsg = `Version ${version} detected in "${resourceRoot}". This extension requires PHP_CodeSniffer/PHPCBF ${MINIMUM_MAJOR_VERSION}.0.0 or higher.`;
      }

      if (warningMsg) {
        logger.warn(warningMsg);
        showWarningOnce(warningMsg);
      }
    }),
  );
};

/**
 * Get the version of PHPCS or PHPCBF, using the cache when the executable has not changed.
 * @param {string} executablePath The path to the PHPCS or PHPCBF executable
 * @param {string} executableName The name of the executable (phpcs or phpcbf) for logging
 * @param {string | undefined} cwd The working directory to run the executable in
 * @returns {Promise<string | null>} The version string or null if it couldn't be determined
 */
const getPhpcsVersion = async (
  executablePath: string,
  executableName: string,
  cwd: string | undefined,
): Promise<string | null> => {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(executablePath)).mtimeMs;
  } catch {
    return null;
  }

  const cached = versionCache.get(executablePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.version;
  }

  const version = detectVersion(executablePath, executableName, cwd);
  versionCache.set(executablePath, { mtimeMs, version });

  // Don't cache failures, so a fixed environment (e.g. PHP added to PATH) is picked up.
  if ((await version) === null) {
    versionCache.delete(executablePath);
  }

  return version;
};

/**
 * Run `<executable> --version` and extract the version number.
 * @param {string} executablePath The path to the PHPCS or PHPCBF executable
 * @param {string} executableName The name of the executable (phpcs or phpcbf) for logging
 * @param {string | undefined} cwd The working directory to run the executable in
 * @returns {Promise<string | null>} The version string or null if it couldn't be determined
 */
const detectVersion = async (
  executablePath: string,
  executableName: string,
  cwd: string | undefined,
): Promise<string | null> => {
  const result = await runCommand(executablePath, ['--version'], {
    cwd,
    timeout: VERSION_TIMEOUT_MS,
  });

  if (result.exitCode !== 0 || result.error) {
    logger.debug(
      `Failed to get ${executableName} version: ${result.error?.message || result.stderr || result.stdout}`,
    );
    return null;
  }

  const output = result.stdout.trim();

  // Verify that the output contains "PHP_CodeSniffer", to ensure it's the correct executable.
  if (!output.includes('PHP_CodeSniffer')) {
    logger.debug(`Invalid output string for ${executableName}: ${output}`);
    return null;
  }

  // Match version patterns like "PHP_CodeSniffer version 4.0.1 (stable) by Squiz and PHPCSStandards".
  const versionMatch = output.match(/(\d+)\.(\d+)\.(\d+)/);

  if (!versionMatch) {
    logger.debug(
      `Could not obtain ${executableName} version from output:`,
      output,
    );
    return null;
  }

  const version = versionMatch[0];
  logger.info(`${executableName} version: ${version}`);

  return version;
};

/**
 * Check if the given version is unsupported (older than the minimum major version).
 * @param {string | null} phpcsVersion The PHPCS version string to check.
 * @param {string | null} phpcbfVersion The PHPCBF version string to check.
 * @returns {boolean} `true` if the version is unsupported, `false` otherwise.
 */
const checkUnsupportedVersion = (
  phpcsVersion: string | null,
  phpcbfVersion: string | null,
): boolean => {
  const isBelowMinimum = (version: string | null): boolean =>
    version != null &&
    parseInt(version.split('.')[0], 10) < MINIMUM_MAJOR_VERSION;

  return isBelowMinimum(phpcsVersion) || isBelowMinimum(phpcbfVersion);
};
