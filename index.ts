/**
 * Push blast-radius guard: intercepts `git push` bash calls and escalates to
 * the user when the push looks like an accident (stacked-PR mis-merge, direct
 * push to a protected branch, push to a remote other than origin). Port of a
 * Claude Code PreToolUse hook, with human confirmation instead of a
 * model-facing deny.
 *
 * Fails open on uncertainty (no git repo, unresolvable base, gh unavailable):
 * this is an accident detector, not a security boundary.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);

const EXTENSION_ID = "blast-radius-guard";

export interface Config {
	threshold: number;
	protectedBranches: string[];
	protectDefaultBranch: boolean;
	draftAction: "warn" | "block";
	allowedRemotes: string[];
}

export const DEFAULT_CONFIG: Config = {
	threshold: 50,
	protectedBranches: ["main", "master", "prod"],
	protectDefaultBranch: true,
	draftAction: "warn",
	allowedRemotes: ["origin"],
};

function readConfigFile(path: string): Partial<Config> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	} catch {
		console.error(`[${EXTENSION_ID}] ignoring malformed config: ${path}`);
		return undefined;
	}
}

function loadConfig(projectDirs: string[]): Config {
	const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	const layers = [
		join(agentDir, "extensions", EXTENSION_ID, "config.json"),
		...projectDirs.map((dir) => join(dir, ".pi", "extensions", EXTENSION_ID, "config.json")),
	].map(readConfigFile);
	return Object.assign({ ...DEFAULT_CONFIG }, ...layers);
}

export function projectConfigDirs(repoRoot: string, pushCwd: string): string[] {
	return pushCwd === repoRoot ? [repoRoot] : [repoRoot, pushCwd];
}

export function parseRegex(pattern: string): RegExp | undefined {
	const match = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
	if (!match) return undefined;
	try {
		return new RegExp(match[1], match[2]);
	} catch {
		return undefined;
	}
}

function nameMatches(branch: string, candidates: string[]): boolean {
	return candidates.some((candidate) => {
		const regex = parseRegex(candidate);
		return regex ? regex.test(branch) : candidate.toLowerCase() === branch.toLowerCase();
	});
}

export function matchesProtected(branch: string, config: Config, defaultBranch?: string): boolean {
	const candidates = [...config.protectedBranches];
	if (config.protectDefaultBranch && defaultBranch) candidates.push(defaultBranch);
	return nameMatches(branch, candidates);
}

export function subcommands(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of command) {
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "&" || char === "|" || char === ";" || char === "\n") {
			if (current.trim()) parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function shellWords(text: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: string | undefined;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
			continue;
		}
		current += char;
		inWord = true;
	}
	if (inWord) words.push(current);
	return words;
}

function withoutEnvPrefixes(words: string[]): string[] {
	let start = 0;
	while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
	return words.slice(start);
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

function parseGitPush(words: string[]): { dirs: string[]; args: string[] } | undefined {
	if (words[0] !== "git") return undefined;
	const dirs: string[] = [];
	let i = 1;
	while (i < words.length && words[i].startsWith("-")) {
		if (!GIT_OPTIONS_WITH_VALUE.has(words[i])) {
			i += 1;
			continue;
		}
		if (i + 1 >= words.length) return undefined;
		if (words[i] === "-C") dirs.push(words[i + 1]);
		i += 2;
	}
	if (words[i] !== "push") return undefined;
	return { dirs, args: words.slice(i + 1) };
}

// Args following `git push` in a subcommand (env prefixes and git global
// options stripped). Anything else (docker push, `echo push`) yields no segment.
export function gitPushArgs(subcommand: string): string[] | undefined {
	return parseGitPush(withoutEnvPrefixes(shellWords(subcommand)))?.args;
}

function resolveDir(dir: string, cwd: string | undefined, home: string): string | undefined {
	const expanded = dir.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
	if (/[$`]/.test(expanded)) return undefined;
	if (expanded.startsWith("/")) return resolve(expanded);
	return cwd === undefined ? undefined : resolve(cwd, expanded);
}

function cdTarget(args: string[], cwd: string | undefined, home: string): string | undefined {
	const operands = args.filter((arg) => !/^-[LPe@]+$/.test(arg));
	if (operands.length === 0) return home;
	if (operands[0] === "-") return undefined;
	return resolveDir(operands[0], cwd, home);
}

export interface PushInvocation {
	cwd: string | undefined;
	args: string[];
}

// The session directory is not always the pushed repo: follow `cd` and
// `git -C` so the guard inspects the repo the push actually runs in. A
// directory it cannot resolve (`cd -`, substitutions) stays undefined and the
// push is let through, like any other uncertainty.
export function pushInvocations(command: string, sessionCwd: string, home: string = homedir()): PushInvocation[] {
	const invocations: PushInvocation[] = [];
	let cwd: string | undefined = sessionCwd;
	for (const subcommand of subcommands(command)) {
		const words = withoutEnvPrefixes(shellWords(subcommand.replace(/^\(+|\)+$/g, "")));
		if (words[0] === "cd") {
			cwd = cdTarget(words.slice(1), cwd, home);
			continue;
		}
		const push = parseGitPush(words);
		if (!push) continue;
		let pushCwd = cwd;
		for (const dir of push.dirs) pushCwd = resolveDir(dir, pushCwd, home);
		invocations.push({ cwd: pushCwd, args: push.args });
	}
	return invocations;
}

// Branch names a push would update. Bare refspecs are taken as-is, `src:dst`
// contributes dst; flags are skipped.
export function pushTargets(args: string[], currentBranch?: string): string[] {
	const positional: string[] = [];
	for (const token of args) {
		if (token.startsWith("-")) continue;
		positional.push(token);
	}
	if (positional.length === 0) return currentBranch ? [currentBranch] : [];
	// First positional is the remote (or a URL); the rest are refspecs.
	const refspecs = positional.slice(1);
	if (refspecs.length === 0) return currentBranch ? [currentBranch] : [];
	const targets: string[] = [];
	for (const refspec of refspecs) {
		const dst = refspec.includes(":") ? refspec.split(":")[1] : refspec;
		if (dst) targets.push(dst);
	}
	return targets;
}

const PUSH_OPTIONS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

// Repository a push names: the first positional argument (a remote name or a
// URL), else --repo. Undefined for a bare push, which git resolves from config.
export function pushRemote(args: string[]): string | undefined {
	let repo: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === "--repo") {
			repo = args[++i];
			continue;
		}
		if (token.startsWith("--repo=")) {
			repo = token.slice("--repo=".length);
			continue;
		}
		if (PUSH_OPTIONS_WITH_VALUE.has(token)) {
			i++;
			continue;
		}
		if (!token.startsWith("-")) return token;
	}
	return repo;
}

// The remote a bare `git push` uses, in git's order of precedence.
export async function configuredPushRemote(cwd: string, branch: string | undefined): Promise<string> {
	const keys = [
		...(branch ? [`branch.${branch}.pushRemote`] : []),
		"remote.pushDefault",
		...(branch ? [`branch.${branch}.remote`] : []),
	];
	for (const key of keys) {
		const value = await run("git", ["config", "--get", key], { cwd })
			.then((r) => r.stdout.trim())
			.catch(() => "");
		if (value) return value;
	}
	return "origin";
}

// "." is the local repository, which git also accepts as a remote.
async function segmentRemotes(
	root: string,
	cwd: string,
	segments: string[][],
): Promise<{ remote: string; allowed: boolean }[]> {
	const { allowedRemotes } = loadConfig(projectConfigDirs(root, cwd));
	const branch = await currentBranch(cwd);
	const remotes: { remote: string; allowed: boolean }[] = [];
	for (const args of segments) {
		const remote = pushRemote(args) ?? (await configuredPushRemote(cwd, branch));
		remotes.push({ remote, allowed: remote === "." || allowedRemotes.includes(remote) });
	}
	return remotes;
}

function repoRoot(cwd: string): Promise<string | undefined> {
	return run("git", ["rev-parse", "--show-toplevel"], { cwd, maxBuffer: 1 << 20 })
		.then((r) => r.stdout.trim() || undefined)
		.catch(() => undefined);
}

function defaultBranch(cwd: string): Promise<string | undefined> {
	return run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd })
		.then((r) => r.stdout.trim().replace(/^origin\//, "") || undefined)
		.catch(() =>
			run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef"], { cwd })
				.then((r) => r.stdout.trim() || undefined)
				.catch(() => undefined),
		);
}
function currentBranch(cwd: string): Promise<string | undefined> {
	return run("git", ["branch", "--show-current"], { cwd })
		.then((r) => r.stdout.trim() || undefined)
		.catch(() => undefined);
}

// Injected shell access, so evaluation logic stays testable without git or gh.
export interface GuardDeps {
	gh(args: string[]): Promise<string>;
	verifyRef(name: string): Promise<boolean>;
	unpushedCommits(branch: string): Promise<number | undefined>;
	diffStats(baseRef: string, headRef: string): Promise<DiffStats | undefined>;
}

export interface DiffStats {
	files: number;
	commits: number;
}

interface PrInfo {
	base: string;
	isDraft: boolean;
}

export async function prForBranch(gh: GuardDeps["gh"], branch: string): Promise<PrInfo | undefined> {
	try {
		const stdout = await gh(["pr", "view", branch, "--json", "baseRefName,isDraft,state"]);
		const pr = JSON.parse(stdout) as {
			baseRefName?: string;
			isDraft?: boolean;
			state?: string;
		};
		if (pr.state !== "OPEN" || !pr.baseRefName) return undefined;
		return { base: pr.baseRefName, isDraft: pr.isDraft === true };
	} catch {
		return undefined;
	}
}

export async function resolveBaseRef(
	verifyRef: GuardDeps["verifyRef"],
	base: string,
): Promise<string | undefined> {
	for (const candidate of [`origin/${base}`, base]) {
		if (await verifyRef(candidate)) return candidate;
	}
	return undefined;
}

// A push may run from a worktree checked out on another branch, so the diff
// head is the pushed branch itself: local first (what the push uploads), then
// the remote ref.
export async function headRefFor(
	verifyRef: GuardDeps["verifyRef"],
	branch: string,
): Promise<string | undefined> {
	for (const candidate of [branch, `origin/${branch}`]) {
		if (await verifyRef(candidate)) return candidate;
	}
	return undefined;
}

export interface RefEvaluation {
	target: string;
	pr?: PrInfo;
	compareRef?: string;
	stats?: DiffStats;
	// Local commits on the PR base that origin lacks (for example after a rebase):
	// GitHub keeps resolving the PR against the older origin ref until the base
	// is pushed too.
	staleBaseCommits?: number;
	baseMissing?: boolean;
	protectedBranch: boolean;
}
// Measure one pushed branch against the base its PR will resolve against after
// the push (local branch when the same command pushes the base, else the base as
// origin holds it): what GitHub shows reviewers is the blast radius that matters.
export async function evaluateTarget(
	deps: GuardDeps,
	config: Config,
	target: string,
	defaultBranch?: string,
	pushedTargets: ReadonlySet<string> = new Set(),
): Promise<RefEvaluation> {
	const evaluation: RefEvaluation = {
		target,
		protectedBranch: matchesProtected(target, config, defaultBranch),
	};
	const pr = await prForBranch(deps.gh, target);
	evaluation.pr = pr;
	const headRef = await headRefFor(deps.verifyRef, target);
	if (!headRef) return evaluation;

	const baseName = pr ? pr.base : defaultBranch;
	if (!baseName) return evaluation;

	const baseRef =
		pushedTargets.has(baseName) && (await deps.verifyRef(baseName))
			? baseName
			: await resolveBaseRef(deps.verifyRef, baseName);
	if (!baseRef) {
		if (pr) evaluation.baseMissing = true;
		return evaluation;
	}
	evaluation.compareRef = baseRef;
	evaluation.stats = await deps.diffStats(baseRef, headRef);

	// A local base behind origin (an integration branch nobody pulls) changes
	// nothing GitHub shows, and a protected base is never one to push.
	if (
		pr &&
		!pushedTargets.has(baseName) &&
		!matchesProtected(baseName, config, defaultBranch)
	) {
		const unpushed = await deps.unpushedCommits(baseName);
		if (unpushed) evaluation.staleBaseCommits = unpushed;
	}
	return evaluation;
}

// Both counts start at the merge base, matching what GitHub shows: a three-dot
// diff for files, and a two-dot range for the branch's own commits (three dots
// would also count the commits the base gained since the branch point).
export async function gitDiffStats(
	baseRef: string,
	headRef: string,
	cwd?: string,
): Promise<DiffStats | undefined> {
	try {
		const [diff, commits] = await Promise.all([
			run("git", ["diff", "--name-only", `${baseRef}...${headRef}`], { cwd, maxBuffer: 1 << 24 }),
			run("git", ["rev-list", "--count", `${baseRef}..${headRef}`], { cwd }),
		]);
		const files = diff.stdout.split("\n").filter((line) => line.trim()).length;
		return { files, commits: Number.parseInt(commits.stdout.trim(), 10) };
	} catch {
		return undefined;
	}
}

export async function gitUnpushedCommits(
	branch: string,
	cwd?: string,
): Promise<number | undefined> {
	try {
		const r = await run("git", ["rev-list", "--count", `origin/${branch}..${branch}`], { cwd });
		return Number.parseInt(r.stdout.trim(), 10);
	} catch {
		return undefined;
	}
}

function realDeps(cwd: string): GuardDeps {
	return {
		gh: async (args) => (await run("gh", args, { cwd })).stdout,
		verifyRef: async (name) => {
			try {
				await run("git", ["rev-parse", "--verify", "-q", name], { cwd });
				return true;
			} catch {
				return false;
			}
		},
		unpushedCommits: (branch) => gitUnpushedCommits(branch, cwd),
		diffStats: (baseRef, headRef) => gitDiffStats(baseRef, headRef, cwd),
	};
}

function refLine(ev: RefEvaluation, config: Config): string {
	const parts: string[] = [];
	if (ev.protectedBranch) parts.push("targets a protected branch");
	if (ev.stats && ev.stats.files > config.threshold) {
		parts.push(`${ev.stats.files} files / ${ev.stats.commits} commits vs ${ev.compareRef}`);
	}
	if (ev.staleBaseCommits && ev.stats && ev.stats.files > config.threshold) {
		const base = ev.pr?.base;
		const commits = ev.staleBaseCommits === 1 ? "1 commit" : `${ev.staleBaseCommits} commits`;
		parts.push(
			`stale base: local ${base} has ${commits} not on origin/${base}; push the base branch first (or the whole stack with --atomic)`,
		);
	}
	if (ev.baseMissing) {
		parts.push(`base ${ev.pr?.base} is not available locally; run git fetch origin first`);
	}
	if (parts.length === 0) {
		parts.push(
			ev.stats
				? `${ev.stats.files} files / ${ev.stats.commits} commits vs ${ev.compareRef}`
				: "diff size unknown (base not resolvable)",
		);
	}
	return `${ev.target}: ${parts.join("; ")} (threshold: ${config.threshold})`;
}

export interface Decision {
	action: "allow" | "warn" | "confirm";
	summary: string;
	draftNote?: string;
}

// Aggregate per-branch evaluations: block (confirm) when at least one branch
// trips the guard and is not on a warn-only path; warn when every tripping
// branch is on one (no open PR yet, or a draft PR when drafts only warn).
export function decide(evaluations: RefEvaluation[], config: Config): Decision {
	const warnOnly = (ev: RefEvaluation) =>
		!ev.protectedBranch && (!ev.pr || (ev.pr.isDraft && config.draftAction === "warn"));
	const significant = evaluations.filter((ev) => {
		const overBase = ev.stats !== undefined && ev.stats.files > config.threshold;
		return ev.protectedBranch || overBase || ev.baseMissing === true;
	});
	if (significant.length === 0) return { action: "allow", summary: "" };

	const lines = significant.map((ev) => refLine(ev, config));
	const inspect = significant.flatMap((ev) =>
		ev.compareRef ? [`git diff --stat ${ev.compareRef}...${ev.target}`] : [],
	);
	const summary =
		inspect.length > 0 ? `${lines.join("; ")}. Inspect: ${inspect.join("; ")}` : `${lines.join("; ")}.`;

	const draft = significant.find((ev) => ev.pr?.isDraft);
	const draftNote = draft
		? "The PR is a draft: review requests and CODEOWNERS notifications only fire once it is marked ready."
		: undefined;

	return significant.every(warnOnly)
		? { action: "warn", summary, draftNote }
		: { action: "confirm", summary, draftNote };
}

const ACTION_RANK: Record<Decision["action"], number> = { allow: 0, warn: 1, confirm: 2 };

export function mergeDecisions(decisions: Decision[]): Decision {
	const relevant = decisions.filter((decision) => decision.action !== "allow");
	if (relevant.length === 0) return { action: "allow", summary: "" };
	const action = relevant.reduce<Decision["action"]>(
		(strictest, decision) => (ACTION_RANK[decision.action] > ACTION_RANK[strictest] ? decision.action : strictest),
		"warn",
	);
	return {
		action,
		summary: relevant.map((decision) => decision.summary).join(" "),
		draftNote: relevant.find((decision) => decision.draftNote)?.draftNote,
	};
}

// Detect a multi-branch push of a stack without --atomic: git updates each
// ref independently, so one rejected ref would still push the others and
// leave the stack base stale on origin while the tip lands. The PR diff
// GitHub displays would then cover the whole stack.
export function stackPushWithoutAtomic(
	segments: { targets: string[]; atomic: boolean }[],
	prBases: ReadonlyMap<string, string | undefined>,
): { targets: string[]; base: string; tip: string } | undefined {
	for (const segment of segments) {
		if (segment.atomic || segment.targets.length < 2) continue;
		const pushed = new Set(segment.targets);
		for (const target of segment.targets) {
			const base = prBases.get(target);
			if (base && pushed.has(base)) return { targets: segment.targets, base, tip: target };
		}
	}
	return undefined;
}

async function evaluateRepo(
	root: string,
	cwd: string,
	segments: string[][],
): Promise<{ stackBlock: string } | { decision: Decision }> {
	const config = loadConfig(projectConfigDirs(root, cwd));
	const deps = realDeps(cwd);
	const branch = await currentBranch(cwd);
	const pushSegments = segments.map((args) => ({ args, atomic: args.includes("--atomic") }));
	const segmentTargets = pushSegments.map((segment) => pushTargets(segment.args, branch));
	const targets = [...new Set(segmentTargets.flat())];
	const defaultBranchName = await defaultBranch(cwd);

	// Each pushed branch is evaluated independently, against the base its own
	// PR resolves against after the push, not the checked-out branch's PR.
	// pushedTargets lets each evaluation project the post-push origin state.
	const pushedTargets = new Set(targets);
	const evaluations: RefEvaluation[] = [];
	for (const target of targets) {
		evaluations.push(await evaluateTarget(deps, config, target, defaultBranchName, pushedTargets));
	}

	// A multi-branch stack push without --atomic can land the tip while the
	// base ref is rejected, leaving GitHub showing the whole stack as the
	// tip's PR diff. Block and steer to --atomic or split pushes.
	const nonAtomicStack = stackPushWithoutAtomic(
		pushSegments.map((segment, i) => ({ targets: segmentTargets[i], atomic: segment.atomic })),
		new Map(evaluations.map((ev) => [ev.target, ev.pr?.base])),
	);
	if (nonAtomicStack) {
		const { targets: stackTargets, base, tip } = nonAtomicStack;
		return {
			stackBlock: `Pushing ${stackTargets.join(", ")} without --atomic, where ${tip}'s PR targets ${base}. If a ref is rejected mid-push, git still updates the others, leaving ${base} stale on origin: GitHub would then show the whole stack as ${tip}'s PR diff. Re-run the same push with --atomic (compatible with --force-with-lease), or push ${base} first and the remaining branches after. If this push is intentional, re-run with ALLOW_BIG_PUSH=1 prepended to the git push.`,
		};
	}
	return { decision: decide(evaluations, config) };
}

async function main(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command ?? "";
		if (!command.includes("push")) return;
		if (/\bALLOW_BIG_PUSH=1\b/.test(command) || process.env.ALLOW_BIG_PUSH === "1") return;

		const invocations = pushInvocations(command, process.cwd());
		if (invocations.length === 0) return;

		const repos = new Map<string, { cwd: string; segments: string[][] }>();
		for (const { cwd, args } of invocations) {
			if (cwd === undefined) continue;
			const root = await repoRoot(cwd);
			if (!root) continue;
			const repo = repos.get(root) ?? { cwd, segments: [] };
			repo.segments.push(args);
			repos.set(root, repo);
		}
		if (repos.size === 0) return;

		const sessionRoot = await repoRoot(process.cwd());
		const offRemotes = new Set<string>();
		for (const [root, repo] of repos) {
			const where = root === sessionRoot ? "" : ` (in ${root})`;
			const remotes = await segmentRemotes(root, repo.cwd, repo.segments);
			for (const { remote, allowed } of remotes) if (!allowed) offRemotes.add(`"${remote}"${where}`);
			repo.segments = repo.segments.filter((_, i) => remotes[i].allowed);
			if (repo.segments.length === 0) repos.delete(root);
		}
		if (offRemotes.size > 0) {
			const summary = `This push goes to ${[...offRemotes].join(", ")}, outside the allowed remotes (allowedRemotes, origin by default).`;
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Push stopped by blast-radius guard. ${summary} No UI is available to ask the user: explain the situation in chat and wait for explicit approval; if approved, re-run with ALLOW_BIG_PUSH=1 prepended to the git push.`,
				};
			}
			const ok = await ctx.ui.confirm("Push blast-radius guard", `${summary}\n\nAllow this push?`);
			if (!ok) {
				return {
					block: true,
					reason: `The user declined this push. ${summary} Push to origin instead, or ask the user why this remote is needed.`,
				};
			}
		}

		// The checks below measure against origin, so they only cover pushes to an allowed remote.
		const decisions: Decision[] = [];
		for (const [root, repo] of repos) {
			const label = root === sessionRoot ? "" : `In ${root}: `;
			const outcome = await evaluateRepo(root, repo.cwd, repo.segments);
			if ("stackBlock" in outcome) {
				return { block: true, reason: `Push stopped by blast-radius guard. ${label}${outcome.stackBlock}` };
			}
			const { decision } = outcome;
			decisions.push(decision.action === "allow" ? decision : { ...decision, summary: `${label}${decision.summary}` });
		}

		const decision = mergeDecisions(decisions);
		if (decision.action === "allow") return;

		if (decision.action === "warn") {
			if (ctx.hasUI) {
				await ctx.ui.notify(`Push blast-radius guard: ${decision.summary}`, "warning");
			}
			return;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Push stopped by blast-radius guard. ${decision.summary} No UI is available to ask the user: explain the situation in chat and wait for explicit approval; if approved, re-run with ALLOW_BIG_PUSH=1 prepended to the git push.${decision.draftNote ? ` ${decision.draftNote}` : ""}`,
			};
		}

		const ok = await ctx.ui.confirm(
			"Push blast-radius guard",
			`${decision.summary}${decision.draftNote ? `\n\n${decision.draftNote}` : ""}\n\nAllow this push?`,
		);
		if (ok) return;

		return {
			block: true,
			reason: `The user declined this push. ${decision.summary} Usual causes: the wrong base was merged into the branch, or the push targets a protected branch by mistake. Remediation: inspect the diff with the git diff --stat command shown above, check the PR base branch, and to undo a wrong merge ask the user before any history rewrite (git reset --soft <correct-parent>, then rebuild the stack).`,
		};
	});
}

export default main;
