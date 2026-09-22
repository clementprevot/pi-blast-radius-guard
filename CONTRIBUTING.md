# Contributing

Thanks for considering a contribution. Contributing here is easy: no build step, no runtime dependencies.

## Setup

```bash
corepack enable   # activates Yarn 4 (pinned in package.json)
yarn install
```

## Before you open a PR

```bash
yarn test        # node:test, runs on the current Node (>= 22.6)
yarn typecheck   # tsc --noEmit
```

Then try the extension in a live session:

```bash
pi -e /path/to/this/repo
```

## Guidelines

- Try to keep the extension dependency-free: pi provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peers. Anything else needs a strong justification.
- No build step. The TypeScript source is what pi loads and what npm ships.
- No network calls, no telemetry, no data collection. This is a guard; it must never phone home. On purpose.
- Tests live in `test/` and run with `node --test`. Pure helpers should stay exported so they stay testable.
- Keep messages shown to the user short and concrete (what happened, what the options are).

## Releasing

Versions are bumped manually and released by tagging:

```bash
npm version patch|minor|major
git push --follow-tags
```

The `release` GitHub Action publishes to npm on `v*` tags using npm trusted publishing (OIDC) (no npm token is stored in the repo).

First publish only: the package name must exist on npm and be linked to this repo as a trusted publisher (npmjs.com, package settings, "Trusted Publisher": repository `clementprevot/pi-blast-radius-guard`, workflow `release.yml`). Publish the first version locally with `npm publish` while logged in, then link the trusted publisher so later tags publish automatically.
