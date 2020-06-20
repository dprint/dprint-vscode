# dprint README

Visual Studio Code formatting extension for [dprint](https://dprint.dev/).

## Features

Formats code in the editor using [dprint](https://dprint.dev/).

Plugins are currently resolved based on the `dprint.config.json` in the current workspace folder or `config` sub directory.

## Requirements

You must have dprint installed globally on the path.

Follow the instructions here: [Install](https://dprint.dev/install/)

## Set Default Formatter

```json
{
    "editor.defaultFormatter": "dprint.dprint",
    // or specify per language (recommended)
    "[typescript]": {
        "editor.defaultFormatter": "dprint.dprint"
    }
}
```

## Extension Settings

Respects formatting on save:

```json
{
    "editor.formatOnSave": true,
    // or per language
    "[typescript]": {
        "editor.formatOnSave": true
    }
}
```

## Known Issues

* No support for custom config locations.

## Release Notes

### 0.1.0

Initial release.
