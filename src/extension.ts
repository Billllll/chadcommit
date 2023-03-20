import * as vscode from 'vscode';
import { request } from "https";
import { TextDecoder } from 'util';

export function activate(context: vscode.ExtensionContext) {
	let isProcessing = false

	let disposable = vscode.commands.registerCommand('chadcommit.suggest', async () => {
		if (isProcessing) {
			vscode.window.showInformationMessage('Thinking...');
			return
		}

		isProcessing = true

		await suggest()

		isProcessing = false
	});

	context.subscriptions.push(disposable);
}

export function deactivate() { }

const suggest = async () => {
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

		if (!stagedChangesDiff) {
			vscode.window.showErrorMessage('Failed to get the diff of the staged changes!');
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

		await turboCompletion({ messages, apiKey: openAiKey, onText: (text) => currentRepo.inputBox.value = text })

	} catch (error: any) {
		vscode.window.showErrorMessage(error.toString());
	}
}


const generateMessages = ({ prompt = '', useEmoji = false }): Array<{ role: string, content: string }> => [
	{
		role: 'system',
		content: `You are a generator of commit messages, you analyze given git diff, you follow bassic commitlint rules to respond with a message that describes changes in smallest form possible. Example: "${useEmoji ? '🚀' : ''}feat(player) add captions\n${useEmoji ? '🔨' : ''}refactor(player) improve support for newer formats\n${useEmoji ? '⚙️' : ''}chore(dependencies): update terser to 5.16.6"`
	},
	{
		role: 'user',
		content: prompt
	}
]


const turboCompletion = ({
	messages = [],
	apiKey = '',
	onText = () => null
}: {
	messages: Array<{ role: string, content: string }>,
	apiKey: string,
	onText: (text: string) => void
}) => {
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
				const contentMatches = decoder.decode(chunk).matchAll(/\{"content":"[^\}]*"\}/g)

				for (const match of contentMatches) {
					const { content } = JSON.parse(match[0])

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
	});
};
