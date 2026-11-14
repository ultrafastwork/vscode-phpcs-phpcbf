/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2019 Samuel Hilson. All rights reserved.
 * Licensed under the MIT License. See License.md in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { commands, type ExtensionContext, languages, workspace } from 'vscode';
import { provideFixerEdits } from './fixer';
import { disposeLogger, logger } from './logger';
import { getSettings, reloadSettings } from './settings';
import {
  activateSniffer,
  disposeSniffer,
  onSnifferSettingsChanged,
  refreshSniffer,
} from './sniffer';
import { getExtensionInfo, setExtensionInfo } from './utils/helpers';

/**
 * Activate Extension
 * @param {ExtensionContext} context The extension context provided by VS Code
 */
export const activate = async (context: ExtensionContext) => {
  setExtensionInfo(context);
  const { id, displayName, version } = getExtensionInfo();

  // Always output extension information to channel on activate
  logger.log(`Extension ID: ${id}.`);
  logger.log(`Extension Display Name: ${displayName}.`);
  logger.log(`Extension Version: ${version}.`);

  await getSettings();

  // A single listener reloads the shared settings, then notifies the sniffer.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(async (event) => {
      if (
        !event.affectsConfiguration('phpsab') &&
        !event.affectsConfiguration('php')
      ) {
        return;
      }
      await reloadSettings();
      onSnifferSettingsChanged(event);
    }),
  );

  // Resource settings are per workspace folder, so reload when folders change.
  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(async () => {
      await reloadSettings();
      refreshSniffer();
    }),
  );

  activateSniffer(context.subscriptions);

  // Register format from command palette
  context.subscriptions.push(
    commands.registerTextEditorCommand('fixer.fix', (textEditor) => {
      if (textEditor.document.languageId === 'php') {
        commands.executeCommand('editor.action.formatDocument');
      }
    }),
  );

  // Register as document formatter for php. PHPCBF always fixes the whole file,
  // so it is registered as a document formatter rather than a range formatter.
  context.subscriptions.push(
    languages.registerDocumentFormattingEditProvider(
      { scheme: 'file', language: 'php' },
      {
        provideDocumentFormattingEdits: (document, _options, token) =>
          provideFixerEdits(document, token),
      },
    ),
  );
};

/**
 * Deactivate Extension
 */
export const deactivate = () => {
  disposeSniffer();
  disposeLogger();
};
