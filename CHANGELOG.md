# Change Log

### 0.9.0

- Support config files in ancestor directories of the workspace.

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

- Add "dprint.path" setting.

### 0.3.0

- Update to work with dprint 0.10.0 (will be backwards compatible with 0.9.0 for now).
- Plugin now re-initializes when the configuration file changes.

### 0.2.1

Fix format error message displaying (was `[object Object]` or whatever instead of a string).

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
