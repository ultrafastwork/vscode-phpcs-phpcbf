import type {
  PathResolver,
  PathResolverOptions,
} from '../interfaces/path-resolver';
import { logger } from '../logger';
import { showWarningOnce } from '../utils/notifications';
import { createComposerPathResolver } from './composer-path-resolver';
import { createGlobalPathResolver } from './global-path-resolver';
import {
  getPlatformExtension,
  getPlatformPathSeparator,
} from './path-resolver-utils';

/**
 * Resolve the path to an executable using the provided resolvers, in order.
 *
 * A resolver that fails (e.g. Composer lists phpcs but `vendor/bin` is missing)
 * produces a warning and the next resolver is tried. If nothing is found an empty
 * string is returned, and settings validation then disables the tool with a
 * warning instead of the whole extension failing to activate.
 *
 * @param {PathResolver[]} resolvers An array of PathResolver objects to attempt resolution with.
 * @param {string} executable The executable name, for logging.
 * @returns {Promise<string>} The resolved path, or an empty string if not found.
 */
const resolvePath = async (
  resolvers: PathResolver[],
  executable: string,
): Promise<string> => {
  for (const resolver of resolvers) {
    try {
      const resolverPath = await resolver.resolve();
      if (resolverPath) {
        return resolverPath;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(message);
      showWarningOnce(message);
    }
  }

  logger.debug(`Unable to locate the ${executable} executable.`);
  return '';
};

/**
 * Create a path resolver for the specified executable.
 * @param {PathResolverOptions} options The options for creating the path resolver.
 * @param {string} executable The name of the executable to resolve.
 * @returns {PathResolver} A PathResolver object for the specified executable.
 */
export const createPathResolver = (
  options: PathResolverOptions,
  executable: string,
): PathResolver => {
  const executableFile = executable + getPlatformExtension();
  const resolvers: PathResolver[] = [];

  // Add a composer path resolver if a workspace root is available, to prioritize
  // the workspace composer-installed executable over the global one.
  if (options.workspaceRoot) {
    resolvers.push(
      createComposerPathResolver(
        executableFile,
        options.workspaceRoot,
        options.composerJsonPath,
      ),
    );
  }
  // Add a global path resolver as a fallback to search
  // through the system env path for the executable.
  resolvers.push(createGlobalPathResolver(executableFile));

  return {
    extension: getPlatformExtension(),
    pathSeparator: getPlatformPathSeparator(),
    resolve: async (): Promise<string> => {
      return resolvePath(resolvers, executableFile);
    },
  };
};
