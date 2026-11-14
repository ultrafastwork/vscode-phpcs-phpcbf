import { type Uri, type WorkspaceConfiguration, workspace } from 'vscode';
import { checkPhpcsVersionCompatibility } from './compatibility';
import type {
  ResourceSettings,
  Settings,
  SnifferMode,
} from './interfaces/settings';
import { logger } from './logger';
import {
  resolveCBFExecutablePath,
  resolveCSExecutablePath,
  resolvePhpExecutablePath,
} from './resolvers/executable-path-resolver';
import {
  addPhpToEnvPath,
  executableExists,
} from './resolvers/path-resolver-utils';
import { getExtensionInfo } from './utils/helpers';
import { showWarningOnce } from './utils/notifications';

/**
 * Check if the editor is in single file mode.
 * @returns {boolean} `true` if no workspace folders are open
 */
export const isSingleFileMode = (): boolean => {
  return !workspace.workspaceFolders;
};

/**
 * Attempt to find the root path for a workspace or resource
 * @param {Uri} resource The workspace resource URI
 * @returns {string} The resolved root path for the given resource,
 * or an empty string if none is found.
 */
const resolveRootPath = (resource: Uri): string => {
  // Try to get a valid folder from resource
  const folder = workspace.getWorkspaceFolder(resource);

  // One last safety check
  return folder ? folder.uri.fsPath : '';
};

/**
 * Validate the PHPCS and PHPCBF executables, ensuring that they exist
 * at the specified paths and disabling sniffer or fixer if necessary.
 * @param settings The resource-specific settings to validate.
 * @param resource The resource (workspace folder or single file) for which the settings are being validated.
 * @returns {Promise<ResourceSettings>} The validated resource settings.
 */
const validate = async (
  settings: ResourceSettings,
  resource: string,
): Promise<ResourceSettings> => {
  let msg = '';
  if (
    settings.snifferEnable &&
    !(await executableExists(settings.executablePathCS))
  ) {
    msg = `The phpcs executable was not found for ${resource}. Sniffer is being disabled for this workspace.`;
    settings.snifferEnable = false;
  }
  if (
    settings.fixerEnable &&
    !(await executableExists(settings.executablePathCBF))
  ) {
    msg = `The phpcbf executable was not found for ${resource}. Fixer is being disabled for this workspace.`;
    settings.fixerEnable = false;
  }

  if (msg) {
    logger.warn(msg);
    showWarningOnce(msg);
  }

  return settings;
};

/**
 * The most recently loaded settings.
 */
let settingsCache: Settings | undefined;

/**
 * The settings load currently in progress, if any.
 */
let pendingLoad: Promise<Settings> | undefined;

/**
 * Incremented on every reload, so a slow, outdated load never overwrites a newer one.
 */
let loadGeneration = 0;

/**
 * Get the current settings, loading them on first use.
 * This is the single shared settings store for the sniffer and the fixer.
 * @returns {Promise<Settings>} The current settings.
 */
export const getSettings = (): Promise<Settings> => {
  if (settingsCache) {
    return Promise.resolve(settingsCache);
  }
  return pendingLoad ?? reloadSettings();
};

/**
 * Reload the settings, e.g. after a configuration or workspace folder change.
 * @returns {Promise<Settings>} The newly loaded settings.
 */
export const reloadSettings = (): Promise<Settings> => {
  const generation = ++loadGeneration;

  const load = loadSettings().then(
    (settings) => {
      if (generation === loadGeneration) {
        settingsCache = settings;
        pendingLoad = undefined;
      }
      return settings;
    },
    (error: unknown) => {
      if (generation === loadGeneration) {
        pendingLoad = undefined;
      }
      throw error;
    },
  );

  pendingLoad = load;
  return load;
};

/**
 * Get the settings of the workspace folder that contains a document.
 * @param {Settings} settings The extension settings.
 * @param {Uri} uri The document URI.
 * @returns {ResourceSettings | undefined} The resource settings, if any.
 */
export const getResourceSettingsFor = (
  settings: Settings,
  uri: Uri,
): ResourceSettings | undefined => {
  const workspaceFolder = workspace.getWorkspaceFolder(uri);
  return settings.resources[workspaceFolder?.index ?? 0];
};

/**
 * Load and validate the extension settings.
 * @returns {Promise<Settings>} The loaded and validated settings.
 */
const loadSettings = async (): Promise<Settings> => {
  const resourcesSettings: Array<ResourceSettings> = [];

  const globalConfig = workspace.getConfiguration('phpsab', null);
  const PHPconfig = workspace.getConfiguration('php', null);

  // Handle case where no workspace folders exist (single file mode).
  if (isSingleFileMode()) {
    const { displayName } = getExtensionInfo();

    const warningMsg = `No workspace folder open. ${displayName} will run with limited functionality. Please open a folder or workspace.`;

    logger.warn(warningMsg);
    showWarningOnce(warningMsg);

    let settings = await getResourceSettings(globalConfig);
    settings = await validate(settings, 'Single File Mode');

    resourcesSettings.push(settings);
  } else {
    // Handle per Workspace settings

    // workspaceFolders is not undefined here, because of the isSingleFileMode check above.
    const workspaceFolders = workspace.workspaceFolders ?? [];

    for (let index = 0; index < workspaceFolders.length; index++) {
      const resource = workspaceFolders[index].uri;
      const config = workspace.getConfiguration('phpsab', resource);
      const rootPath = resolveRootPath(resource);

      let settings = await getResourceSettings(config, rootPath);

      settings = await validate(settings, workspaceFolders[index].name);

      resourcesSettings.push(settings);
    }
  }

  // Update settings from config
  const settings: Settings = {
    resources: resourcesSettings,
    snifferMode: globalConfig.get<SnifferMode>('snifferMode', 'onSave'),
    snifferShowSources: globalConfig.get<boolean>('snifferShowSources', false),
    snifferShowFixabilityIcons: globalConfig.get<boolean>(
      'snifferShowFixabilityIcons',
      true,
    ),
    snifferTypeDelay: globalConfig.get<number>('snifferTypeDelay', 250),
    debug: globalConfig.get<boolean>('debug', false),
    phpExecutablePath: await resolvePhpExecutablePath(globalConfig, PHPconfig),
  };

  if (settings.phpExecutablePath !== '') {
    addPhpToEnvPath(settings.phpExecutablePath);
  }

  logger.setDebugMode(settings.debug);
  logger.debug('CONFIGURATION', settings);

  // Only produces warnings, so don't hold up activation or linting waiting for it.
  checkPhpcsVersionCompatibility(settings).catch((error: unknown) => {
    logger.error(`Version compatibility check failed: ${error}`);
  });

  return settings;
};

/**
 * Get settings from the workspace configuration.
 * @param {WorkspaceConfiguration} config The workspace configuration to retrieve settings from.
 * @param {string | null} rootPath The root path of the workspace or `null` if in single file mode.
 * @returns {Promise<ResourceSettings>} The resource settings for the workspace.
 */
const getResourceSettings = async (
  config: WorkspaceConfiguration,
  rootPath: string | null = null,
): Promise<ResourceSettings> => {
  let settings: ResourceSettings = {
    fixerEnable: config.get<boolean>('fixerEnable', true),
    fixerArguments: config.get<string[]>('fixerArguments', []),
    workspaceRoot: rootPath,
    executablePathCBF: config.get<string>('executablePathCBF', ''),
    executablePathCS: config.get<string>('executablePathCS', ''),
    composerJsonPath: config.get<string>('composerJsonPath', 'composer.json'),
    standard: config.get<string | null>('standard', ''),
    autoRulesetSearch: config.get<boolean>('autoRulesetSearch', true),
    allowedAutoRulesets: config.get<string[]>('allowedAutoRulesets', [
      '.phpcs.xml',
      '.phpcs.xml.dist',
      'phpcs.xml',
      'phpcs.xml.dist',
      'phpcs.ruleset.xml',
      'ruleset.xml',
    ]),
    snifferEnable: config.get<boolean>('snifferEnable', true),
    snifferArguments: config.get<string[]>('snifferArguments', []),
    excludeGlobs: config.get<string[]>('excludeGlobs', [
      '**/vendor/**',
      '**/node_modules/**',
    ]),
  };

  settings = await resolveCBFExecutablePath(settings);
  settings = await resolveCSExecutablePath(settings);

  return settings;
};
