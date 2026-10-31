import type * as vscode from "vscode";

// note: this file should not import "vscode" so that it can be unit tested

/** The parts of vscode's window that tell whether it's focused. */
export type FocusWindow = Pick<typeof vscode.window, "state" | "onDidChangeWindowState">;

/**
 * Calls the listener when the window gets the focus back, which isn't when only whether it's active changed
 * (vscode's window state changes for that too while it's focused).
 */
export function onDidRegainWindowFocus(window: FocusWindow, listener: () => void): vscode.Disposable {
  let isFocused = window.state.focused;
  return window.onDidChangeWindowState(state => {
    const wasFocused = isFocused;
    isFocused = state.focused;
    if (isFocused && !wasFocused) {
      listener();
    }
  });
}
