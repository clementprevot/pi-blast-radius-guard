import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_CONFIG,
	gitPushArgs,
	matchesProtected,
	mergeDecisions,
	parseRegex,
	projectConfigDirs,
	pushInvocations,
	pushRemote,
	pushTargets,
	subcommands,
	type Config,
} from "../index.ts";

test("subcommands splits a chain on separators but not inside quotes", () => {
	assert.deepEqual(subcommands("git push origin main && git push origin dev"), [
		"git push origin main",
		"git push origin dev",
	]);
	assert.deepEqual(subcommands("echo 'push it'; git push"), ["echo 'push it'", "git push"]);
	assert.deepEqual(subcommands("git push origin main | tee log.txt"), [
		"git push origin main",
		"tee log.txt",
	]);
});

test("gitPushArgs detects git push and strips env prefixes", () => {
	assert.deepEqual(gitPushArgs("git push origin main"), ["origin", "main"]);
	assert.deepEqual(gitPushArgs("CI=1 git push origin main"), ["origin", "main"]);
	assert.deepEqual(gitPushArgs("FOO=bar BAZ=qux git push --force"), ["--force"]);
});

test("gitPushArgs ignores non-git-push commands", () => {
	assert.equal(gitPushArgs("docker push my/image"), undefined);
	assert.equal(gitPushArgs("echo push something"), undefined);
	assert.equal(gitPushArgs("git status"), undefined);
	assert.equal(gitPushArgs("FOO=bar"), undefined);
});

test("gitPushArgs skips git global options before push", () => {
	assert.deepEqual(gitPushArgs("git -C /repo push origin main"), ["origin", "main"]);
	assert.deepEqual(gitPushArgs("git -c push.default=current --no-pager push"), []);
	assert.equal(gitPushArgs("git -C"), undefined);
});

test("pushInvocations runs a plain push in the session directory", () => {
	assert.deepEqual(pushInvocations("git push origin main", "/session", "/home"), [
		{ cwd: "/session", args: ["origin", "main"] },
	]);
});

test("pushInvocations follows cd before the push", () => {
	assert.deepEqual(pushInvocations("cd /work/repo && git push", "/session", "/home"), [
		{ cwd: "/work/repo", args: [] },
	]);
	assert.deepEqual(pushInvocations("cd sub && git push", "/session", "/home"), [{ cwd: "/session/sub", args: [] }]);
	assert.deepEqual(pushInvocations("cd /a; cd ../b && git push", "/session", "/home"), [{ cwd: "/b", args: [] }]);
	assert.deepEqual(pushInvocations('cd "/a b" && git push', "/session", "/home"), [{ cwd: "/a b", args: [] }]);
	assert.deepEqual(pushInvocations("(cd /a && git push)", "/session", "/home"), [{ cwd: "/a", args: [] }]);
});

test("pushInvocations expands the home directory", () => {
	assert.deepEqual(pushInvocations("cd ~/dd/web-ui && git push", "/session", "/home"), [
		{ cwd: "/home/dd/web-ui", args: [] },
	]);
	assert.deepEqual(pushInvocations("cd $HOME/x && git push", "/session", "/home"), [{ cwd: "/home/x", args: [] }]);
	assert.deepEqual(pushInvocations("cd && git push", "/session", "/home"), [{ cwd: "/home", args: [] }]);
});

test("pushInvocations applies git -C relative to the current directory", () => {
	assert.deepEqual(pushInvocations("git -C /repo push origin x", "/session", "/home"), [
		{ cwd: "/repo", args: ["origin", "x"] },
	]);
	assert.deepEqual(pushInvocations("cd /work && git -C repo push", "/session", "/home"), [
		{ cwd: "/work/repo", args: [] },
	]);
});

test("pushInvocations leaves the directory unknown when it cannot be resolved", () => {
	assert.deepEqual(pushInvocations('cd "$(git rev-parse --show-toplevel)" && git push', "/session", "/home"), [
		{ cwd: undefined, args: [] },
	]);
	assert.deepEqual(pushInvocations("cd - && git push", "/session", "/home"), [{ cwd: undefined, args: [] }]);
	assert.deepEqual(pushInvocations("git -C $REPO push", "/session", "/home"), [{ cwd: undefined, args: [] }]);
});

test("projectConfigDirs reads the repo root, then a more specific push directory", () => {
	assert.deepEqual(projectConfigDirs("/repo", "/repo"), ["/repo"]);
	assert.deepEqual(projectConfigDirs("/repo", "/repo/pkg"), ["/repo", "/repo/pkg"]);
});

test("mergeDecisions keeps the strictest action and every summary", () => {
	const allow = { action: "allow" as const, summary: "" };
	const warn = { action: "warn" as const, summary: "a: big" };
	const confirm = { action: "confirm" as const, summary: "b: protected", draftNote: "draft" };
	assert.deepEqual(mergeDecisions([allow, allow]), { action: "allow", summary: "" });
	assert.deepEqual(mergeDecisions([allow, warn]), { action: "warn", summary: "a: big", draftNote: undefined });
	assert.deepEqual(mergeDecisions([warn, confirm]), {
		action: "confirm",
		summary: "a: big b: protected",
		draftNote: "draft",
	});
});

test("pushTargets reads bare refspecs and src:dst pairs", () => {
	assert.deepEqual(pushTargets(["origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["origin", "HEAD:main"]), ["main"]);
	assert.deepEqual(pushTargets(["origin", "feature", "HEAD:release/1"]), ["feature", "release/1"]);
});

test("pushTargets skips flags", () => {
	assert.deepEqual(pushTargets(["--force-with-lease", "origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["-f", "origin", "main", "--tags"]), ["main"]);
});

test("pushTargets skips the values of options that take one", () => {
	assert.deepEqual(pushTargets(["-o", "ci.skip", "origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["--push-option", "x", "origin", "HEAD:main"]), ["main"]);
	assert.deepEqual(pushTargets(["--repo", "fork", "origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["-o", "ci.skip", "origin"], "feature"), ["feature"]);
});

test("pushTargets defaults to the current branch", () => {
	assert.deepEqual(pushTargets(["origin"], "feature"), ["feature"]);
	assert.deepEqual(pushTargets([], "feature"), ["feature"]);
	assert.deepEqual(pushTargets(["origin"]), []);
});

test("parseRegex parses /regex/ literals and rejects the rest", () => {
	const regex = parseRegex("/^release\\/.*/i");
	assert.ok(regex instanceof RegExp);
	assert.equal(regex.test("release/2.0"), true);
	assert.equal(parseRegex("main"), undefined);
	assert.equal(parseRegex("/[/"), undefined);
});

test("matchesProtected matches plain names case-insensitively", () => {
	const config: Config = { ...DEFAULT_CONFIG, protectedBranches: ["main"] };
	assert.equal(matchesProtected("MAIN", config), true);
	assert.equal(matchesProtected("develop", config), false);
});

test("matchesProtected matches regex patterns", () => {
	const config: Config = { ...DEFAULT_CONFIG, protectedBranches: ["/^prod(-staging)?$/"] };
	assert.equal(matchesProtected("prod-staging", config), true);
	assert.equal(matchesProtected("production", config), false);
});

test("matchesProtected honors default branch protection", () => {
	const config: Config = { ...DEFAULT_CONFIG, protectDefaultBranch: true };
	assert.equal(matchesProtected("develop", config, "develop"), true);
	const off: Config = { ...config, protectDefaultBranch: false };
	assert.equal(matchesProtected("develop", off, "develop"), false);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	configuredPushRemote,
	decide,
	evaluateTarget,
	gitDiffStats,
	gitUnpushedCommits,
	stackPushWithoutAtomic,
	type DiffStats,
	type GuardDeps,
} from "../index.ts";
interface FakePr {
	baseRefName: string;
	isDraft?: boolean;
	state: string;
}

function fakeDeps(options: {
	prs?: Record<string, FakePr>;
	refs?: string[];
	stats?: Record<string, DiffStats>;
	unpushed?: Record<string, number>;
	ghCalls?: string[][];
}): GuardDeps {
	const { prs = {}, refs = [], stats = {}, unpushed = {}, ghCalls = [] } = options;
	return {
		gh: async (args) => {
			ghCalls.push(args);
			if (args[0] === "pr" && args[1] === "view") {
				const pr = prs[args[2]];
				if (!pr) throw new Error(`no pr for ${args[2]}`);
				return JSON.stringify(pr);
			}
			throw new Error(`unexpected gh args: ${args.join(" ")}`);
		},
		verifyRef: async (name) => refs.includes(name),
		unpushedCommits: async (branch) => unpushed[branch],
		diffStats: async (baseRef, headRef) => stats[`${baseRef}...${headRef}`],
	};
}

const CONFIG: Config = { ...DEFAULT_CONFIG };

test("evaluateTarget uses the pushed branch's PR, not the checked-out branch's", async () => {
	const ghCalls: string[][] = [];
	const deps = fakeDeps({
		prs: { "gh-scope-core": { baseRefName: "preprod", state: "OPEN" } },
		refs: ["origin/preprod", "gh-scope-core"],
		stats: { "origin/preprod...gh-scope-core": { files: 23, commits: 5 } },
		ghCalls,
	});

	// Worktree checked out on gh-scope-ui while pushing gh-scope-core.
	const targets = pushTargets(["origin", "gh-scope-core"], "gh-scope-ui");
	assert.deepEqual(targets, ["gh-scope-core"]);

	const evaluation = await evaluateTarget(deps, CONFIG, targets[0], "master");
	assert.equal(evaluation.compareRef, "origin/preprod");
	assert.deepEqual(evaluation.stats, { files: 23, commits: 5 });
	assert.ok(
		ghCalls.some((args) => args.join(" ") === "pr view gh-scope-core --json baseRefName,isDraft,state"),
		"gh pr view must be called with the pushed branch",
	);
	assert.ok(!ghCalls.some((args) => args.includes("gh-scope-ui")));
});

test("evaluateTarget measures each branch against its own PR base, not the stack root", async () => {
	const ghCalls: string[][] = [];
	const deps = fakeDeps({
		prs: {
			"stack-1": { baseRefName: "stack-0", state: "OPEN" },
			"stack-0": { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/stack-0", "origin/preprod", "stack-1"],
		stats: { "origin/stack-0...stack-1": { files: 12, commits: 3 } },
		ghCalls,
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "stack-1", "master");
	assert.equal(evaluation.compareRef, "origin/stack-0");
	assert.deepEqual(evaluation.stats, { files: 12, commits: 3 });
	assert.equal(ghCalls.length, 1, "no PR-stack walk: one gh call for the pushed branch only");
});

test("a wrong base merged into the branch still blocks at the right base", async () => {
	const deps = fakeDeps({
		prs: { feature: { baseRefName: "preprod", state: "OPEN" } },
		refs: ["origin/preprod", "feature"],
		stats: { "origin/preprod...feature": { files: 7763, commits: 1726 } },
	});

	const decision = decide([await evaluateTarget(deps, CONFIG, "feature", "master")], CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /7763 files/);
	assert.match(decision.summary, /origin\/preprod/);
});

test("a multi-ref push blocks only the oversized ref", async () => {
	const deps = fakeDeps({
		prs: {
			big: { baseRefName: "preprod", state: "OPEN" },
			small: { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/preprod", "big", "small"],
		stats: {
			"origin/preprod...big": { files: 600, commits: 40 },
			"origin/preprod...small": { files: 3, commits: 1 },
		},
	});

	const evaluations = [
		await evaluateTarget(deps, CONFIG, "big", "master"),
		await evaluateTarget(deps, CONFIG, "small", "master"),
	];
	const decision = decide(evaluations, CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /\bbig\b/);
	assert.ok(!decision.summary.includes("small"));
});

test("a push with no open PR falls back to the default branch and only warns", async () => {
	const deps = fakeDeps({
		refs: ["origin/master", "feature"],
		stats: { "origin/master...feature": { files: 60, commits: 2 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "feature", "master");
	assert.equal(evaluation.compareRef, "origin/master");
	assert.equal(evaluation.stats?.files, 60);
	const decision = decide([evaluation], CONFIG);
	assert.equal(decision.action, "warn");
});

test("a protected target without a PR still escalates to confirm", async () => {
	const deps = fakeDeps({
		refs: ["origin/master", "prod"],
		stats: { "origin/master...prod": { files: 1, commits: 1 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "prod", "master");
	const decision = decide([evaluation], CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /targets a protected branch/);
});

test("a draft PR with draftAction warn only warns", async () => {
	const deps = fakeDeps({
		prs: { feature: { baseRefName: "preprod", state: "OPEN", isDraft: true } },
		refs: ["origin/preprod", "feature"],
		stats: { "origin/preprod...feature": { files: 600, commits: 40 } },
	});

	const config: Config = { ...CONFIG, draftAction: "warn" };
	const decision = decide([await evaluateTarget(deps, config, "feature", "master")], config);
	assert.equal(decision.action, "warn");
	assert.match(decision.draftNote ?? "", /draft/);
});

test("a draft PR warns by default instead of asking", async () => {
	const deps = fakeDeps({
		prs: { feature: { baseRefName: "preprod", state: "OPEN", isDraft: true } },
		refs: ["origin/preprod", "feature"],
		stats: { "origin/preprod...feature": { files: 600, commits: 40 } },
	});

	const decision = decide([await evaluateTarget(deps, DEFAULT_CONFIG, "feature", "master")], DEFAULT_CONFIG);
	assert.equal(decision.action, "warn");
	assert.match(decision.draftNote ?? "", /draft/);
});

test("pushing the stack tip alone flags the stale base GitHub will show", async () => {
	const deps = fakeDeps({
		prs: {
			ui: { baseRefName: "core", state: "OPEN" },
			core: { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/core", "ui"],
		unpushed: { core: 2 },
		stats: { "origin/core...ui": { files: 340, commits: 30 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "ui", "master", new Set(["ui"]));
	assert.equal(evaluation.compareRef, "origin/core");
	assert.equal(evaluation.stats?.files, 340);
	assert.equal(evaluation.staleBaseCommits, 2);

	const decision = decide([evaluation], CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /340 files/);
	assert.match(decision.summary, /stale base: local core has 2 commits not on origin\/core/);
});

test("a local base behind origin is not a stale base", async () => {
	const deps = fakeDeps({
		prs: { feature: { baseRefName: "preprod", state: "OPEN" } },
		refs: ["origin/preprod", "feature"],
		unpushed: { preprod: 0 },
		stats: { "origin/preprod...feature": { files: 53, commits: 14 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "feature", "master");
	assert.equal(evaluation.staleBaseCommits, undefined);
	assert.doesNotMatch(decide([evaluation], CONFIG).summary, /stale base/);
});

test("a protected base is never reported as stale", async () => {
	const deps = fakeDeps({
		prs: { feature: { baseRefName: "main", state: "OPEN" } },
		refs: ["origin/main", "feature"],
		unpushed: { main: 3 },
		stats: { "origin/main...feature": { files: 53, commits: 14 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "feature", "master");
	assert.equal(evaluation.staleBaseCommits, undefined);
	assert.doesNotMatch(decide([evaluation], CONFIG).summary, /stale base/);
});

test("pushing the whole stack projects the post-push base and allows", async () => {
	const deps = fakeDeps({
		prs: {
			ui: { baseRefName: "core", state: "OPEN" },
			core: { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/preprod", "core", "ui"],
		stats: { "core...ui": { files: 12, commits: 2 } },
	});

	const evaluation = await evaluateTarget(
		deps,
		CONFIG,
		"ui",
		"master",
		new Set(["core", "ui"]),
	);
	assert.equal(evaluation.compareRef, "core");
	assert.equal(evaluation.stats?.files, 12);
	assert.equal(evaluation.staleBaseCommits, undefined);
	assert.equal(decide([evaluation], CONFIG).action, "allow");
});

test("a PR base missing from origin and not pushed flags the push", async () => {
	const deps = fakeDeps({
		prs: { ui: { baseRefName: "core", state: "OPEN" } },
		refs: ["origin/preprod", "ui"],
		stats: { "origin/preprod...ui": { files: 23, commits: 4 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "ui", "master");
	assert.equal(evaluation.baseMissing, true);

	const decision = decide([evaluation], CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /not available locally/);
});

test("stackPushWithoutAtomic flags only stack pushes without --atomic", () => {
	const prBases = new Map([
		["core", "preprod"],
		["ui", "core"],
		["unrelated-a", "master"],
		["unrelated-b", "master"],
	]);

	const stack = [{ targets: ["core", "ui"], atomic: false }];
	assert.deepEqual(stackPushWithoutAtomic(stack, prBases), { targets: ["core", "ui"], base: "core", tip: "ui" });

	const atomic = [{ targets: ["core", "ui"], atomic: true }];
	assert.equal(stackPushWithoutAtomic(atomic, prBases), undefined);

	const unrelated = [{ targets: ["unrelated-a", "unrelated-b"], atomic: false }];
	assert.equal(stackPushWithoutAtomic(unrelated, prBases), undefined);

	const single = [{ targets: ["ui"], atomic: false }];
	assert.equal(stackPushWithoutAtomic(single, prBases), undefined);
});

// Isolated from the user's git config so signing or hooks cannot break commits.
const SCRATCH_GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function scratchRepo(initialBranch: string) {
	const dir = mkdtempSync(join(tmpdir(), "blast-radius-guard-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env: SCRATCH_GIT_ENV, stdio: "pipe" });
	const commit = (file: string) => {
		writeFileSync(join(dir, file), file);
		git("add", file);
		git("commit", "-q", "-m", file);
	};
	git("init", "-q", "-b", initialBranch);
	return { dir, git, commit };
}

test("gitDiffStats counts only the branch's own commits when the base moved on", async (t) => {
	const repo = scratchRepo("preprod");
	t.after(() => rmSync(repo.dir, { recursive: true, force: true }));

	repo.commit("root.txt");
	repo.git("checkout", "-q", "-b", "feature");
	for (const file of ["a.txt", "b.txt", "c.txt"]) repo.commit(file);
	repo.git("checkout", "-q", "preprod");
	for (let i = 1; i <= 5; i++) repo.commit(`preprod-${i}.txt`);

	assert.deepEqual(await gitDiffStats("preprod", "feature", repo.dir), { files: 3, commits: 3 });
});

test("gitUnpushedCommits counts local commits missing from origin, never the reverse", async (t) => {
	const repo = scratchRepo("core");
	t.after(() => rmSync(repo.dir, { recursive: true, force: true }));

	repo.commit("root.txt");
	repo.git("update-ref", "refs/remotes/origin/core", "HEAD");
	repo.commit("local-1.txt");
	repo.commit("local-2.txt");
	assert.equal(await gitUnpushedCommits("core", repo.dir), 2);

	repo.git("checkout", "-q", "-b", "upstream");
	repo.commit("remote-1.txt");
	repo.git("update-ref", "refs/remotes/origin/core", "HEAD");
	assert.equal(await gitUnpushedCommits("core", repo.dir), 0, "local core is behind origin/core");

	assert.equal(await gitUnpushedCommits("upstream", repo.dir), undefined, "no origin/upstream");
});

test("pushRemote reads the repository a push names", () => {
	assert.equal(pushRemote(["origin", "main"]), "origin");
	assert.equal(pushRemote(["--force-with-lease", "upstream", "HEAD:main"]), "upstream");
	assert.equal(pushRemote(["-o", "ci.skip", "fork", "main"]), "fork");
	assert.equal(pushRemote(["https://example.com/x.git", "HEAD:main"]), "https://example.com/x.git");
	assert.equal(pushRemote(["--repo", "fork"]), "fork");
	assert.equal(pushRemote(["--repo=fork", "--tags"]), "fork");
	assert.equal(pushRemote(["--tags"]), undefined);
	assert.equal(pushRemote([]), undefined);
});

test("configuredPushRemote follows git's precedence for a bare push", async (t) => {
	const isolation = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const previous = Object.fromEntries(Object.keys(isolation).map((key) => [key, process.env[key]]));
	Object.assign(process.env, isolation);
	const repo = scratchRepo("feature");
	t.after(() => {
		rmSync(repo.dir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	assert.equal(await configuredPushRemote(repo.dir, "feature"), "origin");
	repo.git("config", "branch.feature.remote", "upstream");
	assert.equal(await configuredPushRemote(repo.dir, "feature"), "upstream");
	repo.git("config", "remote.pushDefault", "fork");
	assert.equal(await configuredPushRemote(repo.dir, "feature"), "fork");
	repo.git("config", "branch.feature.pushRemote", "mirror");
	assert.equal(await configuredPushRemote(repo.dir, "feature"), "mirror");
	assert.equal(await configuredPushRemote(repo.dir, undefined), "fork");
});

test("only origin is an allowed remote by default", () => {
	assert.deepEqual(DEFAULT_CONFIG.allowedRemotes, ["origin"]);
});
