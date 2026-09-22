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
