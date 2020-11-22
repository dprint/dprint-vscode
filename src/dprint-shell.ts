import * as vscode from "vscode";
import { exec } from "child_process";

interface EditorInfo {
    schemaVersion: number;
    plugins: PluginInfo[];
}

export interface PluginInfo {
    name: string;
    fileExtensions: string[];
}

export async function checkInstalled() {
    try {
        await execShell(`dprint -v`, undefined, undefined);
        return true;
    } catch (err) {
        console.error("[dprint]:", err);
        return false;
    }
}

export async function getEditorInfo() {
    const stdout = await execShell(`dprint editor-info`, undefined, undefined);
    const editorInfo = parseEditorInfo();

    if (!(editorInfo.plugins instanceof Array) || typeof editorInfo.schemaVersion !== "number" || isNaN(editorInfo.schemaVersion)) {
        throw new Error("Error getting editor info. Your editor extension or dprint CLI might be out of date.");
    }

    return editorInfo;

    function parseEditorInfo() {
        try {
            return JSON.parse(stdout) as EditorInfo;
        } catch (err) {
            throw new Error(`Error parsing editor info. Output was: ${stdout}\n\nError: ${err}`);
        }
    }
}

function execShell(
    command: string,
    stdin: string | undefined,
    token: vscode.CancellationToken | undefined,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let cancellationDisposable: vscode.Disposable | undefined;
        try {
            const process = exec(command, {
                cwd: vscode.workspace.rootPath,
                encoding: "utf8",
            }, (err, stdout, stderr) => {
                if (err) {
                    cancellationDisposable?.dispose();
                    reject(stderr);
                    return;
                }
                resolve(stdout.replace(/\r?\n$/, "")); // remove the last newline
                cancellationDisposable?.dispose();
            });
            cancellationDisposable = token?.onCancellationRequested(() => process.kill());
            if (stdin != null) {
                process.stdin!.write(stdin);
                process.stdin!.end();
            }
        } catch (err) {
            reject(err);
            cancellationDisposable?.dispose();
        }
    });
}
