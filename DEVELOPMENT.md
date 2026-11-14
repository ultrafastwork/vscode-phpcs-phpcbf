# vscode-phpcbf

![Current Version](https://img.shields.io/visual-studio-marketplace/v/ultrafastwork.vscode-phpcs-phpcbf)
![Installs](https://img.shields.io/visual-studio-marketplace/i/ultrafastwork.vscode-phpcs-phpcbf)
![GitHub issues](https://img.shields.io/github/issues-raw/ultrafastwork/vscode-phpcs-phpcbf)

Integrates [phpcs & phpcbf](https://github.com/squizlabs/PHP_CodeSniffer.git) into [Visual Studio Code (VS Code)](https://code.visualstudio.com/).

This extension is designed to use an auto config search functionality. When it finds a configuration file through auto search this extension should use that configuration file to create reports with phpcs and apply fixes with phpcbf based on the same configuration.

## Setup Development Version

- Install [pnpm](https://pnpm.io/installation) (the version pinned in `packageManager` in `package.json`, e.g. via `corepack enable`). npm and yarn are not supported.
- Install the VS Code [Biome extension](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) (for linting and formatting code)
- Install the VS Code [markdownlint extension](https://marketplace.visualstudio.com/items?itemName=DavidAnson.vscode-markdownlint) (for linting Markdown files)
- Clone this repository and checkout `develop` branch
- Open the cloned repository folder using VS Code
- Install the dependencies using `pnpm install`

## Run/Debug Development Version

To run the development version of the `vscode-phpcs-phpcbf` extension:

- Open the cloned repository folder using VS Code
- Select sidebar option `Debug`
- Press `Start Debugging` button or hit <kbd>F5</kbd>

This will launch a new VS Code window named `Extension Development Host`, automatically using the development version of the `vscode-phpcs-phpcbf` extension.

## Installing the Development Version

To install a development version of this extension for testing you will need to package the project into a `.vsix` file.

- In the root of the project run: `pnpm run package` (runs `vsce package --no-dependencies` via `pnpm dlx`; the extension is bundled with esbuild, so `node_modules` is not shipped)
- From the VSCode main menu, select "Extensions", click the `...` on the Extensions tab.
- Find the option that is `Install from VSIX...` and follow the prompts.
- After installing, you may need to reload VSCode.

## Publishing Releases

Using the Release system on Github, draft a new release with the desired version tag. The github workflow should handle updating the package.json version and the changelog. It will then publish the release to both VS Marketplace and the Open VSX Registry. These both require a PAT to be set in the security section on github.com and will occasionally need to be updated or rotated if the publishing workflow fails.
