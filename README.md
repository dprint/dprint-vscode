# dprint - Visual Studio Code Extension

Visual Studio Code formatting extension for [dprint](https://dprint.dev/)—a pluggable and configurable code formatting platform.

> I forked [the original repo](https://github.com/dprint/dprint-vscode/) to fix bugs and add new features, because it doesn't seem to be maintained.
>
> Contributions, bug reports and feature requests are welcome.

## Install

1. Install [dprint's CLI](https://dprint.dev/install/)
2. Download the `.vsix` file from the [latest GitHub release](https://github.com/DanteMarshal/dprint-vscode/releases/latest).
3. In VS Code, run **Extensions: Install from VSIX...** and select the downloaded file.

## Setup

1. Run `dprint init` in the root directory of your repository to create a dprint configuration file.
2. Set the default formatter in your vscode settings and consider turning on "format on save":
   ```jsonc
   {
     "editor.defaultFormatter": "dante-marshal.dprint-vscode",
     "editor.formatOnSave": true,
     // or specify per language, for example
     "[javascript]": {
       "editor.defaultFormatter": "dante-marshal.dprint-vscode",
       "editor.formatOnSave": true
     }
   }
   ```

## Features

Formats code in the editor using [dprint](https://dprint.dev/).

Plugins are resolved based on the dprint configuration file used for each file.

Files opened outside the active workspace, including files opened in an empty window, use the nearest ancestor
configuration file and then fall back to the global dprint configuration by default. Set `dprint.useGlobalConfig`
to `false` to disable that fallback.

## Requirements

For workspace files, dprint can be installed in the project's `node_modules`, found on the path, or specified with `dprint.path`. For files outside the workspace, dprint must be on the path or specified with `dprint.path`.

Loose-file formatting requires dprint 0.57 or newer for reliable outside-path and global configuration resolution.

Follow the instructions here: [Install](https://dprint.dev/install/)

## Extension Settings

```jsonc
{
  // By default it will use `dprint` found on the path,
  // but use this when you want to specify a custom location.
  // Include the executable name (ex. on windows "C:\\some-dir\\dprint.exe")
  "dprint.path": "/home/david/otherPath/dprint",
  // Change this to `true` to get verbose logging
  "dprint.verbose": false,
  // Change this to `true` to enable the experimental lsp (requires dprint 0.45+)
  "dprint.experimentalLsp": false
}
```

## Known Issues

- No support for custom config locations.
- In experimental LSP mode, global configuration fallback is limited to the filesystem volume where the language
  server started. Loose files with their own ancestor configuration remain supported across volumes.

## Developing and Testing Locally

1. `npm install`
2. Go to "Run and debug" in VS code and run the "Run Extension" task.
