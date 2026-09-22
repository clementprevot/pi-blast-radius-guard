# @clementprevot/pi-blast-radius-guard

A [Pi](https://pi.dev) extension that catches accidental `git push` commands before they land: a push aimed at a protected branch, or a diff far bigger than the branch was supposed to carry, pauses and you decide. It is an accident detector, not a security boundary: when git or gh are unavailable, or the comparison base cannot be resolved, the guard steps aside and lets the push through.

## Install

```bash
pi install npm:@clementprevot/pi-blast-radius-guard
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch or issue a `/reload` command).

## How it works

On every bash tool call that contains a `git push`, the extension:

1. Splits the command chain into subcommands (respecting quotes) and finds each `git push` invocation, stripping environment-variable prefixes like `FOO=1 git push ...`.
2. Computes the branch names the push would update from the refspecs (`git push origin HEAD:main` targets `main`, `git push origin main` targets `main`, flags are skipped, and a bare `git push` defaults to the current branch).
3. Checks the diff size against a comparison base: the open PR's base branch when one exists, otherwise the default branch. The comparison uses a three-dot diff (changes since the merge base), which matches what GitHub will show once the push lands.
4. Asks you to confirm when the push targets a protected branch, or when the diff exceeds the file threshold. Draft PRs get a note explaining that review requests and CODEOWNERS notifications only fire once the PR is marked ready, but a mis-merge is already in.

When no UI is available (headless session), the push is blocked with an explanation instead of a prompt: the agent is told to explain the situation in chat and wait for your explicit approval. An approved push can be re-run with `ALLOW_BIG_PUSH=1` prepended to the command to skip the guard for that one push.

The guard is intentionally forgiving: outside a git worktree, without gh, or when the base branch cannot be resolved, it fails open and lets the push through. Only pushes with something measurable to protect (a protected target or an oversized diff) trigger a prompt.

## Configuration

Two optional JSON files, merged with project taking precedence over global, which takes precedence over defaults:

- Global: `~/.pi/agent/extensions/blast-radius-guard/config.json`
- Per project: `<repo>/.pi/extensions/blast-radius-guard/config.json`

Schema (shown with defaults):

```json
{
	"threshold": 50,
	"protectedBranches": ["main", "master", "prod"],
	"protectDefaultBranch": true,
	"draftAction": "block"
}
```

- `threshold`: maximum number of changed files (versus the comparison base) before a push trips the guard.
- `protectedBranches`: entries are plain branch names (case-insensitive) or `/regex/` literals such as `/^release\/.*/`.
- `protectDefaultBranch`: also treat the repo's default branch (resolved via git, falling back to gh) as protected.
- `draftAction`: `"block"` asks for confirmation on draft-PR pushes; `"warn"` only warns when the push has no protected target.

To skip the guard for a single push, run it with `ALLOW_BIG_PUSH=1` (in the command or in the environment).

## Privacy and data

The extension shells out locally to `git` and `gh` only. It never sends anything anywhere: no network calls, no telemetry, no data collection.

## Local development

```bash
corepack enable
yarn install
yarn test
yarn typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## Credits

The guard is a port of the original Claude Code push blast-radius hook written by Stephen R. ([srosenthal-dd](https://github.com/srosenthal-dd)), built after one mis-merge too many pinging every code owner of a monorepo.

## License

[MIT](LICENSE)
