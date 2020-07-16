# dprint - Visual Studio Code Extension

Visual Studio Code formatting extension for [dprint](https://dprint.dev/)—a pluggable and configurable code formatting platform.

## Install

1. Install [dprint's CLI](https://dprint.dev/install/)
2. Install extension via [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=dprint.dprint)

## Setup

1. Run `dprint init` in the root directory of your repository to create a `dprint.config.json` file.
2. Set the default formatter in your vscode settings:
   ```json
   {
     "editor.defaultFormatter": "dprint.dprint",
     // or specify per language (recommended)
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
     "[rust]": {
       "editor.defaultFormatter": "dprint.dprint"
     }
   }
   ```
3. Consider turning on "format on save" (see below in Extension Settings)

## Features

Formats code in the editor using [dprint](https://dprint.dev/).

Plugins are currently resolved based on the `.dprintrc.json` in the current workspace folder or `config` sub directory.

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
  }
}
```

## Known Issues

- No support for custom config locations.

## Release Notes

### 0.1.3-0.1.5

Updates based on latest dprint CLI.

### 0.1.2

Fix error text.

### 0.1.1

Auto-dismiss syntax error notifications.

### 0.1.0

Initial release.
