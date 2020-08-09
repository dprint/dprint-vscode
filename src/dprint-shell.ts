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
        console.error(err);
        return false;
    }
}

export async function getPluginInfos() {
    const stdout = await execShell(`dprint editor-info`, undefined, undefined);
    const editorInfo = JSON.parse(stdout) as EditorInfo;
    const currentSchemaVersion = 2;

    // this is done in case the schemaVersion is not an integer for some reason.
    if (editorInfo.schemaVersion !== currentSchemaVersion) {
        if (editorInfo.schemaVersion > currentSchemaVersion) {
            throw new Error(
                "Please upgrade your editor extension to be compatible with the installed version of dprint.",
            );
        } else {
            throw new Error("Your installed version of dprint is out of date. Please update it.");
        }
    }

    return editorInfo.plugins;
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
