import * as assert from "node:assert";
import { describe, it } from "node:test";
import { type FocusWindow, onDidRegainWindowFocus } from "./windowFocus";

describe("onDidRegainWindowFocus", () => {
  it("calls the listener when the window gets the focus back, not when only whether it's active changed", () => {
    let onChange: ((state: { focused: boolean; active: boolean }) => void) | undefined;
    const window = {
      state: { focused: true, active: true },
      onDidChangeWindowState: (listener: typeof onChange) => {
        onChange = listener;
        return { dispose: () => {} };
      },
    } as unknown as FocusWindow;
    let calls = 0;
    onDidRegainWindowFocus(window, () => calls++);

    onChange!({ focused: true, active: false });
    assert.strictEqual(calls, 0);
    onChange!({ focused: false, active: false });
    onChange!({ focused: true, active: false });
    assert.strictEqual(calls, 1);
    onChange!({ focused: true, active: true });
    assert.strictEqual(calls, 1);
  });
});
