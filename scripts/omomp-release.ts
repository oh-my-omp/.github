#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";

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
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: |$)/;

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

function tomlVersion(text: string): RegExpExecArray | undefined {
	const match = tomlVersionLine.exec(text);
	if (!match) return undefined;
	const header = /^\s*\[/m.exec(text);
	return header && header.index < match.index ? undefined : match;
}

const jsonVersionPaths = (file: string): readonly (readonly string[])[] =>
	file.endsWith("package-lock.json") ? [["version"], ["packages", "", "version"]] : [["version"]];

function parseJsonFile(file: string, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		return fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

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

function readChangelog(path: string): Changelog {
	return parseChangelog(path, readFileSync(path, "utf8").split("\n"));
}

function parseChangelog(path: string, lines: string[]): Changelog {
	const first = lines.findIndex((line) => line.startsWith("## "));
	if (first === -1 || lines[first]?.trimEnd() !== UNRELEASED)
		return fail(`${path}: the first ## heading is ${first === -1 ? "missing" : JSON.stringify(lines[first])}, not "${UNRELEASED}"`);
	const next = lines.findIndex((line, index) => index > first && line.startsWith("## "));
	return { lines, unreleasedStart: first, unreleasedEnd: next === -1 ? lines.length : next };
}

function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

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

type Span = { start: number; end: number };

function findSection(lines: readonly string[], version: string): Span | undefined {
	const start = lines.findIndex((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `));
	if (start === -1) return undefined;
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	let end = next === -1 ? lines.length : next;
	while (end > start + 1 && lines[end - 1]?.trim() === "") end--;
	return { start, end };
}

function versionSection(lines: readonly string[], version: string): string | undefined {
	const span = findSection(lines, version);
	return span === undefined ? undefined : trimBlank(lines.slice(span.start + 1, span.end)).join("\n");
}

function remoteVersionTags(remote: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const line of git("ls-remote", "--tags", remote, "refs/tags/v*").split("\n")) {
		const [sha, ref] = line.split(/\s+/);
		if (sha === undefined || ref === undefined) continue;
		tags.set(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""), sha);
	}
	return tags;
}

function fileAt(sha: string, path: string): string[] | undefined {
	if (git("ls-tree", "--name-only", sha, "--", path) === "") return undefined;
	const shown = run(["git", "show", `${sha}:${path}`]);
	if (!shown.ok) return fail(`git show ${sha}:${path}: ${shown.stderr.trim()}`);
	return shown.stdout.split("\n");
}

function diffLines(tag: readonly string[], current: readonly string[]): { removed: string[]; added: number[] } {
	const common: number[][] = Array.from({ length: tag.length + 1 }, () => new Array<number>(current.length + 1).fill(0));
	const at = (i: number, j: number): number => common[i]?.[j] ?? 0;
	for (let i = tag.length - 1; i >= 0; i--)
		for (let j = current.length - 1; j >= 0; j--) {
			const row = common[i];
			if (row !== undefined) row[j] = tag[i] === current[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	const removed: string[] = [];
	const added: number[] = [];
	let i = 0;
	let j = 0;
	while (i < tag.length || j < current.length) {
		if (i < tag.length && j < current.length && tag[i] === current[j]) {
			i++;
			j++;
		} else if (j >= current.length || (i < tag.length && at(i + 1, j) >= at(i, j + 1))) {
			removed.push(tag[i] ?? "");
			i++;
		} else {
			added.push(j);
			j++;
		}
	}
	return { removed, added };
}

type MovedItem = { heading: string; item: string };

function afterLastContent(body: readonly string[], from: number, to: number): number {
	let end = to;
	while (end > from && body[end - 1]?.trim() === "") end--;
	return end;
}

function addItem(body: string[], heading: string, item: string): void {
	const headings = body.flatMap((line, index) => (line.startsWith("### ") ? [index] : []));
	if (heading === "") {
		const first = headings[0] ?? body.length;
		const end = afterLastContent(body, 0, first);
		if (end > 0) body.splice(end, 0, item);
		else body.splice(0, 0, item, ...(first < body.length ? [""] : []));
		return;
	}
	const index = headings.find((h) => body[h]?.trimEnd() === heading);
	if (index === undefined) {
		body.push(...(body.length === 0 ? [] : [""]), heading, "", item);
		return;
	}
	const next = headings.find((h) => h > index) ?? body.length;
	const end = afterLastContent(body, index + 1, next);
	if (end > index + 1) body.splice(end, 0, item);
	else body.splice(index + 1, 0, "", item);
}

function restorePublishedSections(options: Options, changelogPath: string, changelog: Changelog): Changelog {
	const tags = remoteVersionTags(options.remote);
	const path = normalize(changelogPath);
	const lines = [...changelog.lines];
	const moved: MovedItem[] = [];
	const restores: { span: Span; tagText: string[] }[] = [];
	const versions = new Set(lines.flatMap((line) => VERSION_HEADING.exec(line)?.slice(1, 2) ?? []));
	for (const version of versions) {
		const tag = `v${version}`;
		const sha = tags.get(tag);
		const span = findSection(lines, version);
		if (sha === undefined || span === undefined) continue;
		const tagLines = fileAt(sha, path);
		const tagSpan = tagLines === undefined ? undefined : findSection(tagLines, version);
		if (tagLines === undefined || tagSpan === undefined) continue;
		const tagText = tagLines.slice(tagSpan.start, tagSpan.end);
		const current = lines.slice(span.start, span.end);
		const { removed, added } = diffLines(tagText, current);
		if (removed.length === 0 && added.length === 0) continue;
		const foreign = added.flatMap((index) => (TOP_LEVEL_ITEM.test(current[index] ?? "") ? [] : [current[index] ?? ""]));
		if (removed.length > 0 || foreign.length > 0) {
			const quoted = (texts: readonly string[]): string => texts.map((text) => JSON.stringify(text)).join(", ");
			const parts = [
				removed.length > 0 ? `lines of the tag changed or removed: ${quoted(removed)}` : "",
				added.length > 0 ? `lines added: ${quoted(added.map((index) => current[index] ?? ""))}` : "",
				foreign.length > 0 ? `not top-level items: ${quoted(foreign)}` : "",
			].filter((part) => part !== "");
			fail(`${changelogPath}: section "## [${version}]" differs from its tag ${tag}: ${parts.join("; ")}`);
		}
		for (const index of added) {
			const heading = current.slice(0, index).findLast((line) => line.startsWith("### "))?.trimEnd() ?? "";
			moved.push({ heading, item: current[index] ?? "" });
		}
		console.log(`omomp-release: moved ${added.length} top-level item(s) of "## [${version}]" that are not in ${tag} back to "${UNRELEASED}"`);
		restores.push({ span, tagText });
	}
	if (restores.length === 0) return changelog;
	for (const { span, tagText } of restores.reverse()) lines.splice(span.start, span.end - span.start, ...tagText);
	const body = trimBlank(lines.slice(changelog.unreleasedStart + 1, changelog.unreleasedEnd));
	for (const { heading, item } of moved) addItem(body, heading, item);
	lines.splice(changelog.unreleasedStart + 1, changelog.unreleasedEnd - changelog.unreleasedStart - 1, "", ...body, "");
	return parseChangelog(changelogPath, lines);
}

const gmt9Date = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function backfillRelease(options: Options, repo: string, version: string, changelog: Changelog, changelogPath: string): void {
	const tag = `v${version}`;
	if (remoteRef(options.remote, `refs/tags/${tag}`) === undefined) return;
	const view = run(["gh", "release", "view", tag, "--repo", repo, "--json", "tagName"]);
	if (view.ok) return;
	if (!/not found/i.test(view.stderr)) fail(`backfill: gh release view ${tag}: ${view.stderr.trim()}`);
	const notes = versionSection(changelog.lines, version);
	if (notes === undefined) fail(`backfill: ${changelogPath} has no "## [${version}]" section for the Release of ${tag}`);
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
	const changelog = restorePublishedSections(options, changelogPath, readChangelog(changelogPath));

	if (options.githubRepo !== undefined) backfillRelease(options, options.githubRepo, current, changelog, changelogPath);

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
		case "failed": {
			const newline = outcome.reason.indexOf("\n");
			if (newline >= 0) console.log(outcome.reason.slice(newline + 1));
			console.log(`omomp-release: failed: ${newline < 0 ? outcome.reason : outcome.reason.slice(0, newline)}`);
			if (output) writeFileSync(output, "result=failed\n", { flag: "a" });
			return 1;
		}
		default: {
			const never: never = outcome;
			return never;
		}
	}
}

process.exit(main());
