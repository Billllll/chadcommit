import * as vscode from 'vscode';
import { request } from "https";
import { TextDecoder } from 'util';

export function activate(context: vscode.ExtensionContext) {
	let cancellationTokenSource: vscode.CancellationTokenSource | null = null

	let disposable = vscode.commands.registerCommand('chadcommit.suggest', async () => {
		if (cancellationTokenSource) {
			vscode.window.showInformationMessage('Thinking...', 'Cancel').then(selectedItem => {
				if (selectedItem === 'Cancel') {
					cancellationTokenSource?.cancel()
					cancellationTokenSource?.dispose()
					cancellationTokenSource = null
				}
			});
			return
		} else {
			cancellationTokenSource = new vscode.CancellationTokenSource();
		}

		await suggest(cancellationTokenSource.token)

		cancellationTokenSource.dispose()
		cancellationTokenSource = null
	});

	context.subscriptions.push(disposable);
}

export function deactivate() { }

const suggest = async (cancelToken: vscode.CancellationToken) => {
	try {
		const config = vscode.workspace.getConfiguration('chadcommit')

		const openAiKey: string | undefined = config.get('openAiKey')
		const useEmoji: boolean | undefined = config.get('useEmoji')

		if (!openAiKey) {
			const action = "Go to Settings"

			vscode.window.showInformationMessage("Set your OpenAI API key here first!", action)
				.then(selectedItem => {
					if (selectedItem === action) {
						vscode.commands.executeCommand("workbench.action.openSettings", "chadcommit.openAiKey");
					}
				});
			return;
		}

		const gitExtension = vscode.extensions.getExtension('vscode.git');

		if (!gitExtension) {
			vscode.window.showErrorMessage('Failed to find the Git extension!');
			return;
		}

		const git = gitExtension.exports.getAPI(1);

		const currentRepo = git.repositories[0]

		if (!currentRepo) {
			vscode.window.showErrorMessage('Failed to find a Git repository!');
			return;
		}

		const stagedChangesDiff = await currentRepo.diffIndexWith('HEAD');

		if (stagedChangesDiff.length === 0) {
			vscode.window.showErrorMessage('There is no staged changes!');
			return;
		}

		let parsed = [],
			deleted = [],
			renamed = []

		for (const change of stagedChangesDiff) {
			switch (change.status) {
				case 3:
					renamed.push(`RENAMED: ${change.originalUri.path} to ${change.renameUri.path};`);
					break;
				case 6:
					deleted.push(`DELETED: ${change.originalUri.path};`);
					break;
				default:
					const fileDiff = await currentRepo.diffIndexWithHEAD(change.uri.fsPath);
					parsed.push(fileDiff);
					break;
			}
		}

		const messages = generateMessages({
			prompt: `${parsed.join('\n')}\n\n${deleted.join('\n')}\n\n${renamed.join('\n')}`,
			useEmoji
		})

		const cost = messages.reduce((p, c) => p + c.content.length, 0)

		if (cost > 4500) {
			vscode.window.showErrorMessage('Too much staged changes, make it less than 500 words!');
			return;
		}

		await turboCompletion({
			messages,
			apiKey: openAiKey,
			onText: (text) => currentRepo.inputBox.value = text,
			cancelToken
		});
	} catch (error: any) {
		vscode.window.showErrorMessage(error.toString());
	}
}

const generateMessages = ({ prompt = '', useEmoji = false }): Array<{ role: string, content: string }> => [
	{
		role: 'user',
		content: `Analyze a git diff and make a short conventional commit message, follow this template: ${useEmoji ? "🚀" : ""}feat(scope) [message]\n${useEmoji ? "🛠️" : ""}refactor(scope) [message]\n${useEmoji ? "⚙️" : ""}chore(scope) [message];  Response example: "${useEmoji ? "🚀" : ""}feat(player) add captions\n${useEmoji ? "🛠️" : ""}refactor(player) support new formats\n${useEmoji ? "⚙️" : ""}chore(dependencies) upgrade terser to 5.16.6"`
	},
	{
		role: 'user',
		content: prompt
	}
]

type TurboCompletionProps = {
	messages: Array<{ role: string; content: string }>;
	apiKey: string;
	onText: (text: string) => void;
	cancelToken: vscode.CancellationToken;
};

type TurboCompletion = (props: TurboCompletionProps) => Promise<void | string>;

const turboCompletion: TurboCompletion = ({ messages, apiKey, onText, cancelToken }) => {
	return new Promise((resolve, reject) => {
		const options = {
			method: 'POST',
			hostname: 'api.openai.com',
			path: '/v1/chat/completions',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			}
		};

		const req = request(options, res => {
			const decoder = new TextDecoder('utf8');

			if (res.statusCode !== 200) {
				reject(`OpenAI: ${res.statusCode} ${res.statusMessage}`);
			}

			let fullText = '';

			res.on('data', chunk => {
				const dataMatches = decoder.decode(chunk).matchAll(/data: ({.*})\n/g)

				for (const match of dataMatches) {
					const { content } = JSON.parse(match[1]).choices[0].delta

					if (!content) {
						continue
					}

					fullText += content

					onText(fullText)
				}
			});

			res.on('end', () => {
				resolve(fullText);
			});
		});

		req.on('error', error => {
			reject(error);
		});

		req.write(JSON.stringify({
			messages,
			model: "gpt-3.5-turbo",
			max_tokens: 256,
			stream: true
		}));

		req.end();

		cancelToken.onCancellationRequested(() => {
			req.destroy();
			resolve();
		});
	});
};
