import * as vscode from "vscode";
import { checkInstalled, getPluginInfos, PluginInfo, formatText } from "./dprint-shell";

export function activate(context: vscode.ExtensionContext) {
    let formattingSubscription: vscode.Disposable | undefined = undefined;
    const editProvider: vscode.DocumentFormattingEditProvider = {
        async provideDocumentFormattingEdits(document, options, token) {
            try {
                const newText = await formatText(document.fileName, document.getText(), token);
                const lastLineNumber = document.lineCount - 1;
                const replaceRange = new vscode.Range(
                    0,
                    0,
                    lastLineNumber,
                    document.lineAt(lastLineNumber).text.length,
                );
                return [vscode.TextEdit.replace(replaceRange, newText)];
            } catch (err) {
                // It seems there's no way to auto-dismiss notifications,
                // so this uses the Progress API to achieve that.
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Error formatting text",
                }, (progress) => {
                    progress.report({ message: err, increment: 100 });
                    return new Promise(resolve => setTimeout(resolve, 6000));
                });
                console.error("[dprint]:", err);
                return [];
            }
        },
    };

    context.subscriptions.push(vscode.commands.registerCommand("dprint.reset", initializePluginInfos));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(initializePluginInfos));

    initializePluginInfos();
    console.log(`The extension Dprint is now active!`);

    async function initializePluginInfos() {
        const isInstalled = await checkInstalled();
        if (!isInstalled) {
            vscode.window.showErrorMessage(
                "Error initializing dprint. Ensure it is globally installed on the path (see https://dprint.dev/install).",
            );
            return;
        }

        try {
            clearFormattingSubscription();
            const pluginInfos = await getPluginInfos();
            const documentSelectors = getDocumentSelectors(pluginInfos);
            formattingSubscription = vscode.languages.registerDocumentFormattingEditProvider(
                documentSelectors,
                editProvider,
            );
            context.subscriptions.push(formattingSubscription);
        } catch (err) {
            vscode.window.showErrorMessage("Error initializing dprint.", err);
            console.error("[dprint]:", err);
        }

        function getDocumentSelectors(pluginInfos: PluginInfo[]): vscode.DocumentFilter[] {
            const fileExtensions = getFileExtensions();

            if (fileExtensions.size > 0) {
                return [{
                    scheme: "file",
                    pattern: `**/*.{${Array.from(fileExtensions.values()).join(",")}}`,
                }];
            } else {
                return [];
            }

            function getFileExtensions() {
                const fileExtensions = new Set();
                for (const pluginInfo of pluginInfos) {
                    for (const fileExtension of pluginInfo.fileExtensions) {
                        fileExtensions.add(fileExtension);
                    }
                }
                return fileExtensions;
            }
        }
    }

    function clearFormattingSubscription() {
        if (formattingSubscription == null) {
            return;
        }
        const subscriptionIndex = context.subscriptions.indexOf(formattingSubscription);
        if (subscriptionIndex >= 0) {
            context.subscriptions.splice(subscriptionIndex, 1);
        }

        formattingSubscription.dispose();
        formattingSubscription = undefined;
    }
}

// this method is called when your extension is deactivated
export function deactivate() {}
