#!/usr/bin/env bun
/**
 * omomp release run: promotes `## [Unreleased]` of a member's changelog to a version section,
 * bumps every version file, commits `chore: release X.Y.Z` on main and pushes main, tag
 * `vX.Y.Z` and `release` in one atomic push. Run it at the root of a git checkout whose HEAD is
 * the remote main. Each run ends in exactly one result, printed as the last line:
 * `omomp-release: released X.Y.Z`, `omomp-release: nothing-to-release` or
 * `omomp-release: failed: <reason>` (exit 1). A failed run pushes no ref.
 *
 *   bun omomp-release.ts [--package-dir DIR] [--version-files "A B"] [--changelog PATH]
 *                        [--remote NAME] [--github-release OWNER/REPO]
 *
 * `--github-release` (the workflow passes it) also creates the GitHub Release of a new version and,
 * before anything else, backfills the Release of the current version when its tag is on the remote
 * without one. Both go through `gh` with `GH_TOKEN`. Without it nothing on GitHub is touched.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Bump = "major" | "minor" | "patch";
type Version = readonly [number, number, number];
type Options = {
	packageDir: string;
	versionFiles: readonly string[];
	changelog: string;
	remote: string;
	githubRepo: string | undefined;
};
type Outcome = { kind: "released"; version: string } | { kind: "nothing-to-release" } | { kind: "failed"; reason: string };

class ReleaseFailure extends Error {}

function fail(reason: string): never {
	throw new ReleaseFailure(reason);
}

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const UNRELEASED = "## [Unreleased]";
const TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])\s/;

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { packageDir: ".", versionFiles: [], changelog: "", remote: "origin", githubRepo: undefined };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) fail(`missing value for ${flag}`);
		i++;
		switch (flag) {
			case "--package-dir":
				options.packageDir = value === "" ? "." : value;
				break;
			case "--version-files":
				options.versionFiles = value.split(/\s+/).filter((path) => path !== "");
				break;
			case "--changelog":
				options.changelog = value;
				break;
			case "--remote":
				options.remote = value;
				break;
			case "--github-release":
				options.githubRepo = value;
				break;
			default:
				fail(`unknown argument ${flag}`);
		}
	}
	return options;
}

function run(cmd: readonly string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
	const proc = Bun.spawnSync([...cmd], { stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
	return { ok: proc.exitCode === 0, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function git(...args: string[]): string {
	const result = run(["git", ...args]);
	if (!result.ok) fail(`git ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function remoteRef(remote: string, ref: string): string | undefined {
	const line = git("ls-remote", remote, ref);
	return line === "" ? undefined : line.split(/\s+/)[0];
}

function parseVersion(text: string, where: string): Version {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (!match) return fail(`${where}: version ${JSON.stringify(text)} is not X.Y.Z`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpVersion([major, minor, patch]: Version, bump: Bump): Version {
	switch (bump) {
		case "major":
			return major >= 1 ? [major + 1, 0, 0] : [0, minor + 1, 0];
		case "minor":
			return [major, minor + 1, 0];
		case "patch":
			return [major, minor, patch + 1];
		default: {
			const never: never = bump;
			return never;
		}
	}
}

/** The member declaration and the changelog path it resolves to (`--changelog` wins, relative to the repo root). */
function resolveChangelog(options: Options, pkg: unknown): string {
	const declaration = typeof pkg === "object" && pkg !== null && "omomp" in pkg ? pkg.omomp : undefined;
	if (typeof declaration !== "object" || declaration === null || !("changelog" in declaration))
		return fail(`${join(options.packageDir, "package.json")}: missing member declaration "omomp": {"changelog": ...}`);
	if (typeof declaration.changelog !== "string")
		return fail(`${join(options.packageDir, "package.json")}: "omomp.changelog" is not a string`);
	const path = options.changelog !== "" ? options.changelog : join(options.packageDir, declaration.changelog);
	if (!existsSync(path)) fail(`changelog ${path} does not exist`);
	return path;
}

/**
 * Spans of the JSON string values at the given key paths, found by scanning the text so a
 * rewrite changes only those bytes. `paths` are keys from the root, e.g. `["packages", "", "version"]`.
 */
function jsonStringSpans(text: string, paths: readonly (readonly string[])[]): { path: readonly string[]; start: number; end: number }[] {
	const wanted = new Set(paths.map((path) => JSON.stringify(path)));
	const spans: { path: readonly string[]; start: number; end: number }[] = [];
	const stack: { kind: "object" | "array"; key: string | undefined }[] = [];
	let i = 0;
	let expectKey = false;
	const readString = (): { value: string; start: number; end: number } => {
		const start = i;
		i++;
		while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		i++;
		return { value: JSON.parse(text.slice(start, i)) as string, start, end: i };
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === "{" || ch === "[") {
			stack.push({ kind: ch === "{" ? "object" : "array", key: undefined });
			expectKey = ch === "{";
			i++;
		} else if (ch === "}" || ch === "]") {
			stack.pop();
			i++;
		} else if (ch === ",") {
			expectKey = stack.at(-1)?.kind === "object";
			i++;
		} else if (ch === '"') {
			const str = readString();
			const top = stack.at(-1);
			if (expectKey && top) {
				top.key = str.value;
				expectKey = false;
			} else if (top?.kind === "object" && top.key !== undefined) {
				const path = stack.map((frame) => (frame.kind === "array" ? "[]" : (frame.key ?? "")));
				if (wanted.has(JSON.stringify(path))) spans.push({ path, start: str.start, end: str.end });
			}
		} else i++;
	}
	return spans;
}

const tomlVersionLine = /^(version\s*=\s*")([^"]*)(")/m;

/** The top-level `version = "..."` of a TOML file: the match must come before the first table header. */
function tomlVersion(text: string): RegExpExecArray | undefined {
	const match = tomlVersionLine.exec(text);
	if (!match) return undefined;
	const header = /^\s*\[/m.exec(text);
	return header && header.index < match.index ? undefined : match;
}

const jsonVersionPaths = (file: string): readonly (readonly string[])[] =>
	file.endsWith("package-lock.json") ? [["version"], ["packages", "", "version"]] : [["version"]];

/** Parsed JSON of `file`; a file that is not valid JSON fails the run. */
function parseJsonFile(file: string, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		return fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Every version string the file carries; a file whose versions cannot be read fails the run. */
function readVersions(file: string): string[] {
	if (!existsSync(file)) return fail(`version file ${file} does not exist`);
	const text = readFileSync(file, "utf8");
	if (file.endsWith(".json")) {
		parseJsonFile(file, text);
		const paths = jsonVersionPaths(file);
		const spans = jsonStringSpans(text, paths);
		if (spans.length !== paths.length) return fail(`version file ${file}: cannot read ${paths.map((path) => path.join(".")).join(" and ")}`);
		return spans.map(({ start, end }) => JSON.parse(text.slice(start, end)) as string);
	}
	if (file.endsWith(".toml")) {
		const match = tomlVersion(text);
		if (!match) return fail(`version file ${file}: no top-level version = "..." line`);
		return [match[2] ?? ""];
	}
	return fail(`version file ${file}: unsupported extension (only .json and .toml carry versions)`);
}

function writeVersion(file: string, version: string): void {
	const text = readFileSync(file, "utf8");
	if (file.endsWith(".json")) {
		const spans = jsonStringSpans(text, jsonVersionPaths(file)).sort((a, b) => b.start - a.start);
		let next = text;
		for (const { start, end } of spans) next = next.slice(0, start) + JSON.stringify(version) + next.slice(end);
		writeFileSync(file, next);
		return;
	}
	writeFileSync(file, text.replace(tomlVersionLine, `$1${version}$3`));
}

type Changelog = { lines: string[]; unreleasedStart: number; unreleasedEnd: number };

/** The changelog split at its sections; the first `##` heading must be `## [Unreleased]`. */
function readChangelog(path: string): Changelog {
	const lines = readFileSync(path, "utf8").split("\n");
	const first = lines.findIndex((line) => line.startsWith("## "));
	if (first === -1 || lines[first]?.trimEnd() !== UNRELEASED)
		return fail(`${path}: the first ## heading is ${first === -1 ? "missing" : JSON.stringify(lines[first])}, not "${UNRELEASED}"`);
	const next = lines.findIndex((line, index) => index > first && line.startsWith("## "));
	return { lines, unreleasedStart: first, unreleasedEnd: next === -1 ? lines.length : next };
}

/** Body lines of the section without leading and trailing blank lines. */
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

/** Version bump from the `###` categories that hold top-level items; items above any `###` count as patch. */
function bumpFor(body: readonly string[]): Bump | undefined {
	let category = "";
	const categories = new Set<string>();
	for (const line of body) {
		if (line.startsWith("### ")) category = line.slice(4).trim();
		else if (TOP_LEVEL_ITEM.test(line)) categories.add(category);
	}
	if (categories.size === 0) return undefined;
	if (categories.has("Breaking Changes")) return "major";
	if (categories.has("Added")) return "minor";
	return "patch";
}

/** Body of `## [V]` (up to the next `##`), or undefined when the changelog has no such section. */
function versionSection(path: string, version: string): string | undefined {
	const lines = readFileSync(path, "utf8").split("\n");
	const heading = lines.findIndex((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `));
	if (heading === -1) return undefined;
	const next = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
	return trimBlank(lines.slice(heading + 1, next === -1 ? lines.length : next)).join("\n");
}

const gmt9Date = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/** Creates the Release of the current version when its tag is on the remote without one. Pushes nothing. */
function backfillRelease(options: Options, repo: string, version: string, changelog: string): void {
	const tag = `v${version}`;
	if (remoteRef(options.remote, `refs/tags/${tag}`) === undefined) return;
	const view = run(["gh", "release", "view", tag, "--repo", repo, "--json", "tagName"]);
	if (view.ok) return;
	if (!/not found/i.test(view.stderr)) fail(`backfill: gh release view ${tag}: ${view.stderr.trim()}`);
	const notes = versionSection(changelog, version);
	if (notes === undefined) fail(`backfill: ${changelog} has no "## [${version}]" section for the Release of ${tag}`);
	const created = run(["gh", "release", "create", tag, "--repo", repo, "--verify-tag", "--title", tag, "--notes-file", "-"], notes);
	if (!created.ok) fail(`backfill: gh release create ${tag}: ${created.stderr.trim()}`);
	console.log(`omomp-release: backfilled the GitHub Release ${tag}`);
}

function release(options: Options): Outcome {
	const pkgPath = join(options.packageDir, "package.json");
	if (!existsSync(pkgPath)) fail(`${pkgPath} does not exist`);
	const pkg = parseJsonFile(pkgPath, readFileSync(pkgPath, "utf8"));
	const changelogPath = resolveChangelog(options, pkg);
	const versionFiles = [pkgPath, ...options.versionFiles];
	const [current] = readVersions(pkgPath);
	if (current === undefined) return fail(`${pkgPath}: no version`);
	const currentVersion = parseVersion(current, pkgPath);
	for (const file of options.versionFiles)
		for (const found of readVersions(file))
			if (found !== current) fail(`version file ${file} has version ${found}, but ${pkgPath} has ${current}`);
	const changelog = readChangelog(changelogPath);

	if (options.githubRepo !== undefined) backfillRelease(options, options.githubRepo, current, changelogPath);

	const body = trimBlank(changelog.lines.slice(changelog.unreleasedStart + 1, changelog.unreleasedEnd));
	const bump = bumpFor(body);
	if (bump === undefined) return { kind: "nothing-to-release" };
	const version = bumpVersion(currentVersion, bump).join(".");
	const tag = `v${version}`;

	if (remoteRef(options.remote, `refs/tags/${tag}`) !== undefined) fail(`tag ${tag} already exists on ${options.remote}`);
	const releaseHead = remoteRef(options.remote, "refs/heads/release");
	if (releaseHead !== undefined) {
		git("fetch", "--quiet", options.remote, "refs/heads/release");
		if (!run(["git", "merge-base", "--is-ancestor", releaseHead, "HEAD"]).ok) fail(`release (${releaseHead}) is not an ancestor of main`);
	}

	const section = [UNRELEASED, "", `## [${version}] - ${gmt9Date()}`, "", ...body, ""];
	const lines = [...changelog.lines.slice(0, changelog.unreleasedStart), ...section, ...changelog.lines.slice(changelog.unreleasedEnd)];
	writeFileSync(changelogPath, lines.join("\n"));
	for (const file of versionFiles) writeVersion(file, version);
	git("add", "--", changelogPath, ...versionFiles);
	git("-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "--quiet", "-m", `chore: release ${version}`);
	git("tag", tag);
	const push = run(["git", "push", "--atomic", options.remote, "HEAD:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`, "HEAD:refs/heads/release"]);
	if (!push.ok) {
		run(["git", "tag", "-d", tag]);
		fail(`push rejected (main, ${tag} and release were not updated): ${push.stderr.trim()}`);
	}

	if (options.githubRepo !== undefined) {
		const created = run(["gh", "release", "create", tag, "--repo", options.githubRepo, "--verify-tag", "--title", tag, "--notes-file", "-"], body.join("\n"));
		if (!created.ok) fail(`pushed ${tag}, but gh release create failed (the next run backfills it): ${created.stderr.trim()}`);
	}
	return { kind: "released", version };
}

function main(): number {
	let outcome: Outcome;
	try {
		outcome = release(parseArgs(Bun.argv.slice(2)));
	} catch (error) {
		if (!(error instanceof ReleaseFailure)) throw error;
		outcome = { kind: "failed", reason: error.message };
	}
	const output = process.env.GITHUB_OUTPUT;
	switch (outcome.kind) {
		case "released":
			console.log(`omomp-release: released ${outcome.version}`);
			if (output) writeFileSync(output, `result=released\nversion=${outcome.version}\n`, { flag: "a" });
			return 0;
		case "nothing-to-release":
			console.log("omomp-release: nothing-to-release");
			if (output) writeFileSync(output, "result=nothing-to-release\n", { flag: "a" });
			return 0;
		case "failed":
			console.log(`omomp-release: failed: ${outcome.reason}`);
			if (output) writeFileSync(output, "result=failed\n", { flag: "a" });
			return 1;
		default: {
			const never: never = outcome;
			return never;
		}
	}
}

process.exit(main());
