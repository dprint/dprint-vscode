import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import * as path from 'path'
import { GlobalConfiguration } from '@dprint/formatter';

export interface Config extends GlobalConfiguration {
	"$schema": string
	includes: string[]
	excludes: string[]
	plugins: string[]
}

export async function readWorkspaceConfig(): Promise<Config> {
	// TODO: add support for multi-workspace mode
	// TODO: verify if this behavior matches the dprint cli
	const dprintPath = vscode.Uri.file(path.join(vscode.workspace.rootPath!, "dprint.json"))
	const config = await vscode.workspace.fs.readFile(dprintPath)
	return JSON.parse(new TextDecoder("utf-8").decode(config))
}

