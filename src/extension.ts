// This file implements the VS Code extension "chadcommit".
// It provides a command "chadcommit.suggest" that suggests a commit message using OpenAI.
import * as vscode from "vscode";
import { request } from "https";
import { TextDecoder } from "util";

/**
 * This function registers the "chadcommit.suggest" command.
 *
 * When the command is invoked, it shows a prompt asking if the user wants to cancel the operation if it's already running.
 * If the user confirms cancelation, the operation is canceled and the extension is ready to start a new one.
 * If the user doesn't confirm cancelation, the extension starts a new operation using the provided cancellation token.
 *
 * This command is triggered by the "CHAD: Suggest commit message" command in the Command Palette.
 *
 * 💡 This is the main entry point for the extension's functionality.
 *
 * @param context The extension context.
 */
export function activate(context: vscode.ExtensionContext) {
  let cancellationTokenSource: vscode.CancellationTokenSource | null = null;

  let disposable = vscode.commands.registerCommand(
    "chadcommit.suggest",
    async () => {
      if (cancellationTokenSource) {
        vscode.window
          .showInformationMessage("Thinking...", "Cancel")
          .then((selectedItem) => {
            if (selectedItem === "Cancel") {
              cancellationTokenSource?.cancel();
              cancellationTokenSource?.dispose();
              cancellationTokenSource = null;
            }
          });
        return;
      } else {
        cancellationTokenSource = new vscode.CancellationTokenSource();
      }

      await suggest(cancellationTokenSource.token);

      cancellationTokenSource.dispose();
      cancellationTokenSource = null;
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

/**
 * 💡 Suggest a commit message using OpenAI.
 *
 * This function is triggered by the "CHAD: Suggest commit message" command in the Command Palette.
 *
 * @param cancelToken The cancellation token to cancel the request.
 */
const suggest = async (cancelToken: vscode.CancellationToken) => {
  try {
    const config = vscode.workspace.getConfiguration("chadcommit");

    const openAiKey: string | undefined = config.get("openAiKey");
    const prompt: string | undefined = config.get("prompt");
    const model: string | undefined = config.get("model");

    if (!openAiKey) {
      const action = "Go to Settings";

      vscode.window
        .showInformationMessage("Set your OpenAI API key here first!", action)
        .then((selectedItem) => {
          if (selectedItem === action) {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "chadcommit.openAiKey",
            );
          }
        });
      return;
    }

    const gitExtension = vscode.extensions.getExtension("vscode.git");

    if (!gitExtension) {
      vscode.window.showErrorMessage("Failed to find the Git extension!");
      return;
    }

    const git = gitExtension.exports.getAPI(1);

    const currentRepo = git.repositories[0];

    if (!currentRepo) {
      vscode.window.showErrorMessage("Failed to find a Git repository!");
      return;
    }

    const stagedChangesDiff = await currentRepo.diffIndexWith("HEAD");

    if (stagedChangesDiff.length === 0) {
      vscode.window.showErrorMessage("There is no staged changes!");
      return;
    }

    let parsed = [],
      deleted = [],
      renamed = [];

    for (const change of stagedChangesDiff) {
      switch (change.status) {
        case 3:
          renamed.push(
            `RENAMED: ${change.originalUri.path} to ${change.renameUri.path};`,
          );
          break;
        case 6:
          deleted.push(`DELETED: ${change.originalUri.path};`);
          break;
        default:
          const fileDiff = await currentRepo.diffIndexWithHEAD(
            change.uri.fsPath,
          );
          parsed.push(fileDiff);
          break;
      }
    }

    if (model !== "mixtral-8x7b-32768" && model !== "llama2-70b-chat") {
      vscode.window.showErrorMessage("Completion model is not set!");
      return;
    }

    if (!prompt || prompt.length < 10) {
      vscode.window.showErrorMessage("Prompt is too short!");
      return;
    }

    await turboCompletion({
      opts: {
        messages: [
          {
            role: "system",
            content: prompt,
          },
          {
            role: "user",
            content: `Git diff info in triple quotes:\n'''\n${parsed.join("\n")}\n\n${deleted.join("\n")}\n\n${renamed.join("\n")}\n'''\n`,
          },
        ],
        model,
        max_tokens: 256,
        stream: true,
      },
      apiKey: openAiKey,
      onText: (text) => (currentRepo.inputBox.value = text),
      cancelToken,
    });
  } catch (error: any) {
    vscode.window.showErrorMessage(error.toString());
  }
};

type TurboCompletion = (props: {
  opts: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    model: "mixtral-8x7b-32768" | "llama2-70b-chat";
    max_tokens: number;
    stream: boolean;
  };
  apiKey: string;
  onText: (text: string) => void;
  cancelToken: vscode.CancellationToken;
}) => Promise<void | string>;

/**
 * Make a TurboCompletion request to OpenAI's API and stream the results
 * to the `onText` callback.
 *
 * 🚀💡
 *
 * @param {{
 *   opts: {
 *     messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
 *     model:
 *       | "mixtral-8x7b-32768"
 *       | "llama2-70b-chat";
 *     max_tokens: number;
 *     stream: boolean;
 *   };
 *   apiKey: string;
 *   onText: (text: string) => void;
 *   cancelToken: vscode.CancellationToken;
 * }} props
 * @returns {Promise<void | string>}
 */
const turboCompletion: TurboCompletion = ({
  opts,
  apiKey,
  onText,
  cancelToken,
}) => {
  return new Promise((resolve, reject) => {
    const options = {
      method: "POST",
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    };

    const req = request(options, (res) => {
      const decoder = new TextDecoder("utf8");

      if (res.statusCode !== 200) {
        let errorData = "";
        res.on("data", (chunk) => {
          errorData += decoder.decode(chunk);
        });
        res.on("end", () => {
          try {
            const errorObj = JSON.parse(errorData || "{}");
            reject(
              `OpenAI: ${res.statusCode} - ${errorObj.error?.code || "unknown"}`,
            );
          } catch (e) {
            reject(`OpenAI: ${res.statusCode} - Error parsing error response`);
          }
        });
        return;
      }

      let fullText = "";
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += decoder.decode(chunk);
        let eolIndex;
        while ((eolIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.substring(0, eolIndex).trim();
          buffer = buffer.substring(eolIndex + 1);
          if (line.startsWith("data:")) {
            if (line === "data: [DONE]") {
              resolve(fullText);
            }
            try {
              const data = JSON.parse(line.substring(5));
              const content = data.choices[0].delta.content;
              if (content) {
                fullText += content;
                onText(fullText);
              }
            } catch (e: any) {
              reject("Error parsing SSE data: " + e.message);
            }
          }
        }
      });

      res.on("end", () => {
        resolve(fullText);
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(JSON.stringify(opts));

    req.end();

    cancelToken.onCancellationRequested(() => {
      req.destroy();
      resolve();
    });
  });
};
