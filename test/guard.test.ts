import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_CONFIG,
	gitPushArgs,
	matchesProtected,
	parseRegex,
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

test("pushTargets reads bare refspecs and src:dst pairs", () => {
	assert.deepEqual(pushTargets(["origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["origin", "HEAD:main"]), ["main"]);
	assert.deepEqual(pushTargets(["origin", "feature", "HEAD:release/1"]), ["feature", "release/1"]);
});

test("pushTargets skips flags", () => {
	assert.deepEqual(pushTargets(["--force-with-lease", "origin", "main"]), ["main"]);
	assert.deepEqual(pushTargets(["-f", "origin", "main", "--tags"]), ["main"]);
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

import {
	decide,
	evaluateTarget,
	isIntegrationBranch,
	rootBaseRef,
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
	ghCalls?: string[][];
}): GuardDeps {
	const { prs = {}, refs = [], stats = {}, ghCalls = [] } = options;
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
		diffStats: async (baseRef, headRef) => stats[`${baseRef}...${headRef}`],
	};
}

const CONFIG: Config = { ...DEFAULT_CONFIG };

test("isIntegrationBranch covers protected, default, and staging branches", () => {
	assert.equal(isIntegrationBranch("preprod", CONFIG, "master"), true);
	assert.equal(isIntegrationBranch("master", CONFIG, "master"), true);
	assert.equal(isIntegrationBranch("gh-scope-core", CONFIG, "master"), false);
});

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

test("evaluateTarget walks a two-PR stack to the integration branch", async () => {
	const deps = fakeDeps({
		prs: {
			"stack-1": { baseRefName: "stack-0", state: "OPEN" },
			"stack-0": { baseRefName: "preprod", state: "OPEN" },
		},
		// origin/stack-0 exists but is stale; only the preprod ref is a valid root.
		refs: ["origin/stack-0", "origin/preprod", "stack-1"],
		stats: { "origin/preprod...stack-1": { files: 12, commits: 3 } },
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "stack-1", "master");
	assert.equal(evaluation.compareRef, "origin/preprod");
	assert.deepEqual(evaluation.stats, { files: 12, commits: 3 });
});

test("rootBaseRef terminates on a PR-base cycle", async () => {
	const deps = fakeDeps({
		prs: {
			a: { baseRefName: "b", state: "OPEN" },
			b: { baseRefName: "a", state: "OPEN" },
		},
	});

	const result = await rootBaseRef(deps, "a", CONFIG, "master");
	assert.ok(result.root);
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

test("pushing the stack tip alone flags the stale base GitHub will show", async () => {
	const deps = fakeDeps({
		prs: {
			ui: { baseRefName: "core", state: "OPEN" },
			core: { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/core", "origin/preprod", "ui"],
		stats: {
			"origin/preprod...ui": { files: 23, commits: 4 },
			"origin/core...ui": { files: 340, commits: 30 },
		},
	});

	const evaluation = await evaluateTarget(deps, CONFIG, "ui", "master", new Set(["ui"]));
	assert.equal(evaluation.stats?.files, 23);
	assert.equal(evaluation.visibleRef, "origin/core");
	assert.equal(evaluation.visibleStats?.files, 340);

	const decision = decide([evaluation], CONFIG);
	assert.equal(decision.action, "confirm");
	assert.match(decision.summary, /340 files/);
	assert.match(decision.summary, /stale base/);
});

test("pushing the whole stack projects the post-push base and allows", async () => {
	const deps = fakeDeps({
		prs: {
			ui: { baseRefName: "core", state: "OPEN" },
			core: { baseRefName: "preprod", state: "OPEN" },
		},
		refs: ["origin/preprod", "core", "ui"],
		stats: {
			"origin/preprod...ui": { files: 23, commits: 4 },
			"core...ui": { files: 12, commits: 2 },
		},
	});

	const evaluation = await evaluateTarget(
		deps,
		CONFIG,
		"ui",
		"master",
		new Set(["core", "ui"]),
	);
	assert.equal(evaluation.visibleRef, "core");
	assert.equal(evaluation.visibleStats?.files, 12);
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
