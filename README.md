# @clementprevot/pi-blast-radius-guard

A [Pi](https://pi.dev) extension that catches accidental `git push` commands before they land: a push aimed at a protected branch, or a diff far bigger than the branch was supposed to carry, pauses and you decide. It is an accident detector, not a security boundary: when git or gh are unavailable, or the comparison base cannot be resolved, the guard steps aside and lets the push through.

## Install

```bash
pi install npm:@clementprevot/pi-blast-radius-guard
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch or issue a `/reload` command).

## How it works

1. Splits the command chain into subcommands (respecting quotes) and finds each `git push` invocation, stripping environment-variable prefixes like `FOO=1 git push ...`.
2. Computes the branch names the push would update from the refspecs (`git push origin HEAD:main` targets `main`, `git push origin main` targets `main`, flags are skipped, and a bare `git push` defaults to the current branch).
3. Evaluates each pushed branch independently: it resolves the open PR of that branch (not the checked-out one) and measures one three-dot diff (changes since the merge base) against the base the PR will resolve against after the push: the local branch when the same command pushes that base, otherwise the base as origin holds it. The repo default branch stands in when the branch has no open PR. This matches what GitHub shows reviewers, which is the blast radius that matters.
4. Flags a stale base: when the PR base exists locally at a different commit than origin holds (for example after a rebase), GitHub keeps resolving the PR against the stale origin ref until the base is pushed too, so an oversized summary line comes with a hint to push the base branch first.
5. Blocks, with no prompt, a multi-branch push of a stack (one pushed branch is another's PR base) that lacks `--atomic`: without it, one rejected ref still pushes the others and can leave the base stale on origin while the tip lands. The block steers the agent to a re-run with `--atomic`, or to separate pushes with the base first.
6. Asks you to confirm when any pushed branch targets a protected branch or when the measured diff exceeds the file threshold, with one summary line per offending branch. Draft PRs only warn: a draft pings no reviewers, so the guard notes the size in the conversation and lets the push through.
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
	"draftAction": "warn"
}
```

- `threshold`: maximum number of changed files (versus the comparison base) before a push trips the guard.
- `protectedBranches`: entries are plain branch names (case-insensitive) or `/regex/` literals such as `/^release\/.*/`.
- `protectDefaultBranch`: also treat the repo's default branch (resolved via git, falling back to gh) as protected.
- `draftAction`: `"warn"` (default) only warns on draft-PR pushes, since a draft pings nobody; `"block"` asks for confirmation instead.
To skip the guard for a single push, run it with `ALLOW_BIG_PUSH=1` (in the command or in the environment).

## Privacy and data

The extension shells out locally to `git` and `gh` only. It never sends anything anywhere: no network calls, no telemetry, no data collection.

## Local development

```bash
npm install
npm test
npm run typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## Credits

The guard is a port of the original Claude Code push blast-radius hook written by Stephen R. ([srosenthal-dd](https://github.com/srosenthal-dd)), built after one mis-merge too many pinging every code owner of a monorepo.

## License

[MIT](LICENSE)
