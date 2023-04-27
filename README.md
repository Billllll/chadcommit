# chadCommit

This extension simplifies the process of making descriptive commit messages. It utilizes ChatGPT 3.5 Turbo (10x more cost-effective than competing models, GPT 4 is available too) to suggest suitable text based on the changes you've staged. You can experiment with the suggestions and find the ideal commit message or edit it as needed.

However, due to limitations in context understanding and the inherent constraints of GPT, it may not generate perfect commit messages every time. Thus, it is best to use this tool primarily for suggestions.

## See it in action

![Preview](https://i.imgur.com/HpWqdj3.gif)

## Customizing messages
You can edit the GPT prompt in the extension settings to fit your preferred style of messages.

### Prompt example: 
```
Analyze a git diff and make a short conventional commit message, follow this template: 🚀feat(scope) [message]\n🛠️refactor(scope) [message]\n⚙️chore(scope) [message]; Response example: 🚀feat(player) add captions\n🛠️refactor(player) support new formats\n⚙️chore(dependencies) upgrade terser to 5.16.6
```
## Requirements

* You should obtain an OpenAI API key here:
  https://platform.openai.com/account/api-keys

* It is recommended to keep your commits small. Unstage less significant, large, and auto-generated files (such as package-lock) before clicking the "Suggest" button to avoid token limit errors, which occur at around 500 words for GPT 3.5 and 1000 words for GPT 4.
