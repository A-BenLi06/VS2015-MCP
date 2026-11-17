# Agent workflow

- Treat this repository as a git-tracked workspace.
- After every completed file modification, run `git status --short`, stage only the files changed for that modification, and create a git commit before starting the next modification.
- Keep commits focused and use concise commit messages that describe the completed change.
- Do not rewrite, squash, reset, or amend commits unless the user explicitly asks for it.
- If tests or validation are relevant to a modification, run them before committing and mention the result in the commit message or final update.
- After each commit, automatically push the current branch to its configured upstream with `git push`. When creating a new branch, publish it with `git push --set-upstream <remote> <branch>` so subsequent commits push to that remote automatically. Never force-push; if pushing is rejected, inspect the remote state and resolve without rewriting remote history.
