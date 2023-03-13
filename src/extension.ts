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

		await suggest(context)

		isProcessing = false
	});

	context.subscriptions.push(disposable);
}

export function deactivate() { }

const suggest = async (context: vscode.ExtensionContext) => {
	try {
		const config = vscode.workspace.getConfiguration('chadcommit')

		const openAiKey: string | undefined = config.get('openAiKey')
		const useEmoji: boolean | undefined = config.get('useEmoji')
		const isUnlocked = config.get('unlocker') === 'test'

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

		let numTrialCalls: number | undefined

		if (!isUnlocked) {
			numTrialCalls = context.globalState.get("chadcommit.numTrialCalls") || 10

			if (numTrialCalls === 1) {
				const promptUserActionPurchase = "Get the Code 🔑";
				const promptUserActionEnterKey = "Paste it here 🔓";

				vscode.window.showWarningMessage(`🚨 Hey, yo. As a developer, sure you understand how much time and effort goes into solo building and maintaining code. If you'd like to continue using it, please purchase an Unlocker Code. Your support would be greatly appreciated 🤙. And as a thank you, I'll be sure to open source it later!`, promptUserActionPurchase, promptUserActionEnterKey)
					.then(selectedItem => {
						if (selectedItem === promptUserActionPurchase) {
							vscode.env.openExternal(vscode.Uri.parse("https://www.yourwebsite.com/purchase"));
						} else if (selectedItem === promptUserActionEnterKey) {
							vscode.commands.executeCommand("workbench.action.openSettings", "chadcommit.unlocker");
						}
					});
				return
			}
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

		await openAiCompletion({ messages, apiKey: openAiKey, onText: (text) => currentRepo.inputBox.value = text })

		if (numTrialCalls) {
			context.globalState.update("chadcommit.numTrialCalls", --numTrialCalls);
		}
	} catch (error: any) {
		vscode.window.showErrorMessage(error.toString());
	}
}


const generateMessages = ({ prompt = '', useEmoji = false }): Array<{ role: string, content: string }> => [
	{
		role: 'system',
		content: `You are to act as the author of a commit message in git. Your mission is to create clean and comprehensive commit messages in the conventional commit convention. I'll send you an output of 'git diff --staged' command, and you convert it into a commit message. ${useEmoji ? 'Use Gitmoji convention to preface the commit' : 'Do not preface the commit with anything'}, use the present tense. Don't add any descriptions to the commit, only commit message.`
	},
	{
		role: 'user',
		content: `diff --git a/src/server.ts b/src/server.ts
	index ad4db42..f3b18a9 100644
	--- a/src/server.ts
	+++ b/src/server.ts
	@@ -10,7 +10,7 @@ import {
	  initWinstonLogger();
	  
	  const app = express();
	-const port = 7799;
	+const PORT = 7799;
	  
	  app.use(express.json());
	  
	@@ -34,6 +34,6 @@ app.use((_, res, next) => {
	  // ROUTES
	  app.use(PROTECTED_ROUTER_URL, protectedRouter);
	  
	-app.listen(port, () => {
	-  console.log(\`Server listening on port \${port}\`);
	+app.listen(process.env.PORT || PORT, () => {
	+  console.log(\`Server listening on port \${PORT}\`);
	  });`
	},
	{
		role: 'assistant',
		content: `${useEmoji ? '🐛 ' : ''}fix(server.ts): change port variable case from lowercase port to uppercase PORT\n${useEmoji ? '✨ ' : ''}feat(server.ts): add support for process.env.PORT environment variable`
	},
	{
		role: 'user',
		content: prompt
	}
]

const openAiCompletion = ({
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
				const delta = decoder.decode(chunk).match(/"delta":\s*({.*?"content":\s*".*?"})/)?.[1];
				if (delta) {
					const content = JSON.parse(delta).content;
					fullText += content;
					onText(fullText);
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
