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
	draftAction: "block",
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

export function matchesProtected(branch: string, config: Config, defaultBranch?: string): boolean {
	const candidates = [...config.protectedBranches];
	if (config.protectDefaultBranch && defaultBranch) candidates.push(defaultBranch);
	return candidates.some((candidate) => {
		const regex = parseRegex(candidate);
		return regex ? regex.test(branch) : candidate.toLowerCase() === branch.toLowerCase();
	});
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

interface PrInfo {
	base: string;
	isDraft: boolean;
}

async function openPr(): Promise<PrInfo | undefined> {
	try {
		const { stdout } = await run("gh", [
			"pr",
			"view",
			"--json",
			"baseRefName,isDraft,state",
		]);
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

async function resolveBaseRef(base: string): Promise<string | undefined> {
	for (const candidate of [`origin/${base}`, base]) {
		try {
			await run("git", ["rev-parse", "--verify", "-q", candidate]);
			return candidate;
		} catch {
		}
	}
	return undefined;
}

// Three-dot diff: changes since the merge base, matching what GitHub sees.
async function diffStats(
	baseRef: string,
): Promise<{ files: number; commits: number } | undefined> {
	try {
		const [diff, commits] = await Promise.all([
			run("git", ["diff", "--name-only", `${baseRef}...HEAD`], { maxBuffer: 1 << 24 }),
			run("git", ["rev-list", "--count", `${baseRef}...HEAD`]),
		]);
		const files = diff.stdout.split("\n").filter((line) => line.trim()).length;
		return { files, commits: Number.parseInt(commits.stdout.trim(), 10) };
	} catch {
		return undefined;
	}
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

		const cwd = process.cwd();
		const config = loadConfig(cwd);
		const branch = await currentBranch();
		const targets = segments.flatMap((args) => pushTargets(args, branch));
		const defaultBranchName = await defaultBranch();

		const protectedTargets = targets.filter((target) =>
			matchesProtected(target, config, defaultBranchName),
		);

		// Compare base: the open PR's base when there is one, otherwise the
		// default branch (what a push would eventually land on).
		const pr = await openPr();
		let compareRef = pr ? await resolveBaseRef(pr.base) : undefined;
		if (!pr && defaultBranchName) {
			compareRef = await resolveBaseRef(defaultBranchName);
		}
		const stats = compareRef ? await diffStats(compareRef) : undefined;
		const overThreshold = stats !== undefined && stats.files > config.threshold;

		// No measurable base: nothing to protect, fail open.
		if (protectedTargets.length === 0 && !overThreshold) return;

		const statLine = stats
			? `${stats.files} files / ${stats.commits} commits vs ${compareRef} (threshold: ${config.threshold})`
			: "diff size unknown (base not resolvable)";
		const inspect = compareRef ? `\nInspect: git diff --stat ${compareRef}...HEAD` : "";
		const summary = protectedTargets.length
			? `Push targets protected branch(es): ${protectedTargets.join(", ")}. ${statLine}.${inspect}`
			: `Push diff is large: ${statLine}.${inspect}`;

		const draftNote = pr?.isDraft
			? "The open PR is a draft; review requests and CODEOWNERS notifications only fire once it is marked ready, but the mis-merge is already in."
			: undefined;

		// Non-blocking warning paths: draft PRs when draftAction is warn, and
		// no open PR at all (nothing to review yet, so nothing to protect).
		const warnOnly =
			(protectedTargets.length === 0 && !pr) ||
			(pr?.isDraft && config.draftAction === "warn" && protectedTargets.length === 0);
		if (warnOnly) {
			if (ctx.hasUI) {
				await ctx.ui.notify(`Push blast-radius guard: ${summary}`, "warning");
			}
			return;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Push stopped by blast-radius guard. ${summary} No UI is available to ask the user: explain the situation in chat and wait for explicit approval; if approved, re-run with ALLOW_BIG_PUSH=1 prepended to the git push.${draftNote ? ` ${draftNote}` : ""}`,
			};
		}

		const ok = await ctx.ui.confirm(
			"Push blast-radius guard",
			`${summary}${draftNote ? `\n\n${draftNote}` : ""}\n\nAllow this push?`,
		);
		if (ok) return;

		return {
			block: true,
			reason: `The user declined this push. ${summary} Usual causes: the wrong base was merged into the branch, or the push targets a protected branch by mistake. Remediation: inspect the diff with git diff --stat${compareRef ? ` ${compareRef}...HEAD` : " <base>...HEAD"}, check the PR base branch, and to undo a wrong merge ask the user before any history rewrite (git reset --soft <correct-parent>, then rebuild the stack).`,
		};
	});
}

export default main;
