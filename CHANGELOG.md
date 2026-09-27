# Changelog

## 0.0.1

First release of this fork, based on [the original extension's 0.17.2 release](https://github.com/dprint/dprint-vscode/tree/4d1992624bbdd71f5349aed0b79fc77141219b3d#0172).

- Format files outside an active workspace, including in empty windows, using the nearest ancestor or global dprint configuration.
- Provide the dprint configuration schema when the experimental LSP backend is enabled.
- Improve formatting during LSP restarts and serialize backend reinitialization.
- Add a new extension icon and change the extension ID to `dante-marshal.dprint-vscode`.
- Validate the extension on Linux, macOS, and Windows, and test the packaged VSIX before GitHub releases.
