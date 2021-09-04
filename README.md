# dprint - Visual Studio Code Extension

Visual Studio Code formatting extension for [dprint](https://dprint.dev/)—a pluggable and configurable code formatting platform.

Requires dprint 0.17 or above.

## Install

1. Install [dprint's CLI](https://dprint.dev/install/)
2. Install extension via [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=dprint.dprint)

## Setup

1. Run `dprint init` in the root directory of your repository to create a dprint configuration file.
2. Set the default formatter in your vscode settings:
   ```jsonc
   {
     "editor.defaultFormatter": "dprint.dprint",
     // or specify per language
     "[javascript]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[typescript]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[json]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[jsonc]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[markdown]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[toml]": {
       "editor.defaultFormatter": "dprint.dprint"
     },
     "[rust]": {
       "editor.defaultFormatter": "dprint.dprint"
     }
   }
   ```
3. Consider turning on "format on save" (see below in Extension Settings)

## Features

Formats code in the editor using [dprint](https://dprint.dev/).

Plugins are currently resolved based on the dprint configuration file in the current workspace folder.

## Requirements

You must have dprint installed globally on the path.

Follow the instructions here: [Install](https://dprint.dev/install/)

## Extension Settings

Respects formatting on save:

```jsonc
{
  "editor.formatOnSave": true,
  // or per language
  "[typescript]": {
    "editor.formatOnSave": true
  },
  // By default it will use `dprint` found on the path,
  // but use this when you want to specify a custom location.
  // Include the executable name (ex. on windows "C:\\some-dir\\dprint.exe")
  "dprint.path": "/home/david/otherPath/dprint",
  // Change this to `true` to get verbose logging
  "dprint.verbose": false
}
```

## Known Issues

- No support for custom config locations.

## Release Notes

### 0.8.0

- Support for dprint 0.17
- Get config file schema from plugins.

### 0.7.0

- Add logging to "output" tab in vscode (under "dprint").
- Add `"dprint.verbose"` config for outputting verbose logging.

### 0.6.0

- Support dprint 0.13

### 0.5.0

- Support dprint 0.12

### 0.4.0

- Added `dprint.path` setting.

### 0.3.0

- Update to work with dprint 0.10.0 (will be backwards compatible with 0.9.0 for now).
- Plugin now re-initializes when the configuration file changes.

### 0.2.0

Formatting is faster due to using a long-running background process for formatting.

### 0.1.6

- Instructional message when dprint is not installed globally.
- Fix encoding issue on error.

### 0.1.3-0.1.5

Updates based on latest dprint CLI.

### 0.1.2

Fix error text.

### 0.1.1

Auto-dismiss syntax error notifications.

### 0.1.0

Initial release.
