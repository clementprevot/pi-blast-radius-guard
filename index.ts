/**
 * Push blast-radius guard: intercepts `git push` bash calls and escalates to
 * the user when the push looks like an accident (stacked-PR mis-merge, direct
 * push to a protected branch). Port of a Claude Code PreToolUse hook, with
 * human confirmation instead of a model-facing deny.
 *
 * Fails open on uncertainty (no git repo, unresolvable base, gh unavailable):
 * this is an accident detector, not a security boundary.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

export const DEFAULT_CONFIG: Config = {
	threshold: 50,
	protectedBranches: ["main", "master", "prod"],
	protectDefaultBranch: true,
	draftAction: "warn",
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

function loadConfig(cwd: string): Config {
	const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	const global = readConfigFile(
		join(agentDir, "extensions", EXTENSION_ID, "config.json"),
	);
	const project = readConfigFile(
		join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json"),
	);
	return { ...DEFAULT_CONFIG, ...global, ...project };
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

// Args following `git push` in a subcommand (env prefixes stripped). Anything
// else (docker push, `echo push`) yields no segment.
export function gitPushArgs(subcommand: string): string[] | undefined {
	let cmd = subcommand.trim();
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) {
		const space = cmd.indexOf(" ");
		if (space === -1) return undefined;
		cmd = cmd.slice(space + 1);
	}
	const tokens = cmd.split(/\s+/);
	if (tokens[0] !== "git" || tokens[1] !== "push") return undefined;
	return tokens.slice(2);
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

function insideWorkTree(): Promise<boolean> {
	return run("git", ["rev-parse", "--is-inside-work-tree"], { maxBuffer: 1 << 20 })
		.then((r) => r.stdout.trim() === "true")
		.catch(() => false);
}

function defaultBranch(): Promise<string | undefined> {
	return run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
		.then((r) => r.stdout.trim().replace(/^origin\//, "") || undefined)
		.catch(() =>
			run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef"])
				.then((r) => r.stdout.trim() || undefined)
				.catch(() => undefined),
		);
}
function currentBranch(): Promise<string | undefined> {
	return run("git", ["branch", "--show-current"])
		.then((r) => r.stdout.trim() || undefined)
		.catch(() => undefined);
}

// Injected shell access, so evaluation logic stays testable without git or gh.
export interface GuardDeps {
	gh(args: string[]): Promise<string>;
	verifyRef(name: string): Promise<boolean>;
	refSha(name: string): Promise<string | undefined>;
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
	// The PR base exists locally at a different commit than origin holds, so
	// GitHub keeps resolving the PR against the stale origin ref until the
	// base is pushed too.
	staleBase?: boolean;
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

	if (pr && !pushedTargets.has(baseName)) {
		const [localSha, remoteSha] = await Promise.all([
			deps.refSha(baseName),
			deps.refSha(`origin/${baseName}`),
		]);
		evaluation.staleBase =
			localSha !== undefined && remoteSha !== undefined && localSha !== remoteSha;
	}
	return evaluation;
}

// Three-dot diff: changes since the merge base, matching what GitHub sees.
async function gitDiffStats(
	baseRef: string,
	headRef: string,
): Promise<DiffStats | undefined> {
	try {
		const [diff, commits] = await Promise.all([
			run("git", ["diff", "--name-only", `${baseRef}...${headRef}`], { maxBuffer: 1 << 24 }),
			run("git", ["rev-list", "--count", `${baseRef}...${headRef}`]),
		]);
		const files = diff.stdout.split("\n").filter((line) => line.trim()).length;
		return { files, commits: Number.parseInt(commits.stdout.trim(), 10) };
	} catch {
		return undefined;
	}
}

function realDeps(): GuardDeps {
	return {
		gh: async (args) => (await run("gh", args)).stdout,
		verifyRef: async (name) => {
			try {
				await run("git", ["rev-parse", "--verify", "-q", name]);
				return true;
			} catch {
				return false;
			}
		},
		refSha: async (name) => {
			try {
				const r = await run("git", ["rev-parse", name]);
				return r.stdout.trim();
			} catch {
				return undefined;
			}
		},
		diffStats: gitDiffStats,
	};
}

function refLine(ev: RefEvaluation, config: Config): string {
	const parts: string[] = [];
	if (ev.protectedBranch) parts.push("targets a protected branch");
	if (ev.stats && ev.stats.files > config.threshold) {
		parts.push(`${ev.stats.files} files / ${ev.stats.commits} commits vs ${ev.compareRef}`);
	}
	if (ev.staleBase && ev.stats && ev.stats.files > config.threshold) {
		parts.push(
			`stale base: origin/${ev.pr?.base} is behind the local branch; push the base branch first (or the whole stack with --atomic)`,
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

async function main(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command ?? "";
		if (!command.includes("push")) return;
		if (/\bALLOW_BIG_PUSH=1\b/.test(command) || process.env.ALLOW_BIG_PUSH === "1") return;

		const segments = subcommands(command)
			.map(gitPushArgs)
			.filter((args): args is string[] => args !== undefined);
		if (segments.length === 0) return;

		if (!(await insideWorkTree())) return;

		const config = loadConfig(process.cwd());
		const deps = realDeps();
		const branch = await currentBranch();
		const pushSegments = segments.map((args) => ({ args, atomic: args.includes("--atomic") }));
		const segmentTargets = pushSegments.map((segment) => pushTargets(segment.args, branch));
		const targets = [...new Set(segmentTargets.flat())];
		const defaultBranchName = await defaultBranch();

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
				block: true,
				reason: `Push stopped by blast-radius guard. Pushing ${stackTargets.join(", ")} without --atomic, where ${tip}'s PR targets ${base}. If a ref is rejected mid-push, git still updates the others, leaving ${base} stale on origin: GitHub would then show the whole stack as ${tip}'s PR diff. Re-run the same push with --atomic (compatible with --force-with-lease), or push ${base} first and the remaining branches after. If this push is intentional, re-run with ALLOW_BIG_PUSH=1 prepended to the git push.`,
			};
		}
		const decision = decide(evaluations, config);
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
