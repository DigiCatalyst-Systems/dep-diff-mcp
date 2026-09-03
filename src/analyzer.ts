import semver from "semver";
import { LRUCache } from "lru-cache";

export type Ecosystem = "npm" | "pypi" | "github-actions";

const cache = new LRUCache<string, object>({
	max: 500,
	ttl: 1000 * 60 * 60,
});

async function cached<T extends object>(key: string, fn: () => Promise<T>): Promise<T> {
	const hit = cache.get(key);
	if (hit !== undefined) return hit as T;
	const value = await fn();
	cache.set(key, value);
	return value;
}

// A type alias rather than an interface: only aliases carry an implicit index
// signature, which is what lets an analysis be returned as MCP structuredContent.
export type PackageAnalysis = {
	package: string;
	ecosystem: Ecosystem;
	fromVersion: string;
	toVersion: string;
	semverClass: "major" | "minor" | "patch" | "downgrade" | "unknown";
	repoUrl: string | null;
	releaseCount: number;
	breakingChanges: string[];
	releaseExcerpts?: { tag: string; excerpt: string }[];
	securityFixes: { id: string; summary: string; severity: string }[];
	migrationLinks: string[];
	recommendation: string;
	recommendationLevel: "safe" | "likely-safe" | "review" | "caution" | "security";
};

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
	npm: "npm",
	pypi: "PyPI",
	"github-actions": "GitHub Actions",
};

// ---------- GitHub Actions ----------

// An action reference IS its repository: `actions/checkout` lives at
// github.com/actions/checkout, so no registry lookup is needed. A nested action
// such as `github/codeql-action/init` still belongs to the two-segment repo.
export function parseActionRepo(name: string): { owner: string; repo: string } | null {
	if (name.startsWith("@")) return null;
	const [owner, repo] = name.split("/");
	if (!owner || !repo) return null;
	return { owner, repo };
}

// OSV publishes no version enumeration for the "GitHub Actions" ecosystem, so a
// query carrying a version matches nothing and every advisory is missed. Query by
// package alone and evaluate the ranges here instead.
export function isVersionAffected(vuln: any, name: string, version: string): boolean {
	const parsed = semver.coerce(version);
	if (!parsed) return false;

	for (const affected of vuln?.affected ?? []) {
		if (affected?.package?.name !== name) continue;

		if (Array.isArray(affected.versions) && affected.versions.length > 0) {
			if (affected.versions.some((v: string) => semver.coerce(v)?.version === parsed.version)) {
				return true;
			}
		}

		for (const range of affected.ranges ?? []) {
			let introduced: semver.SemVer | null = null;
			for (const event of range?.events ?? []) {
				if (event.introduced !== undefined) {
					introduced = event.introduced === "0" ? semver.coerce("0.0.0") : semver.coerce(event.introduced);
					if (introduced && semver.lt(parsed, introduced)) introduced = null;
				} else if (event.fixed !== undefined && introduced) {
					const fixed = semver.coerce(event.fixed);
					if (fixed && semver.lt(parsed, fixed)) return true;
					introduced = null;
				} else if (event.last_affected !== undefined && introduced) {
					const last = semver.coerce(event.last_affected);
					if (last && semver.lte(parsed, last)) return true;
					introduced = null;
				}
			}
			// An introduced bound the version cleared, with no fix after it.
			if (introduced) return true;
		}
	}
	return false;
}

export function selectFixedCves(vulns: any[], name: string, from: string, to: string): any[] {
	return vulns.filter(
		(v) => isVersionAffected(v, name, from) && !isVersionAffected(v, name, to)
	);
}

// ---------- Semver classification ----------

export function classifyBump(from: string, to: string): PackageAnalysis["semverClass"] {
	const cleanFrom = semver.coerce(from)?.version;
	const cleanTo = semver.coerce(to)?.version;
	if (!cleanFrom || !cleanTo) return "unknown";
	if (semver.eq(cleanFrom, cleanTo)) return "patch";
	if (semver.lt(cleanTo, cleanFrom)) return "downgrade";
	const diff = semver.diff(cleanFrom, cleanTo);
	if (diff === "major" || diff === "premajor") return "major";
	if (diff === "minor" || diff === "preminor") return "minor";
	return "patch";
}

// ---------- Package metadata fetchers ----------

async function fetchNpmMeta(name: string) {
	return cached(`npm:${name}`, async () => {
		const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
		if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${name}`);
		return res.json() as Promise<any>;
	});
}

async function fetchPyPIMeta(name: string) {
	return cached(`pypi:${name}`, async () => {
		const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
		if (!res.ok) throw new Error(`PyPI returned ${res.status} for ${name}`);
		return res.json() as Promise<any>;
	});
}

// ---------- GitHub repo discovery ----------

export function extractGitHubRepo(meta: any, ecosystem: Ecosystem): { owner: string; repo: string } | null {
	let candidates: string[] = [];
	if (ecosystem === "npm") {
		const r = meta?.repository;
		if (typeof r === "string") candidates.push(r);
		else if (r?.url) candidates.push(r.url);
		if (meta?.homepage) candidates.push(meta.homepage);
		if (meta?.bugs?.url) candidates.push(meta.bugs.url);
	} else {
		const urls = meta?.info?.project_urls ?? {};
		candidates = [
			urls.Source, urls.Repository, urls["Source Code"],
			urls.Homepage, urls.Code, meta?.info?.home_page
		].filter(Boolean);
	}
	for (const url of candidates) {
		const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/);
		if (m && m[1] && m[2]) {
			const repo = m[2].replace(/\.git$/, "");
			return { owner: m[1], repo };
		}
	}
	return null;
}

// ---------- GitHub releases ----------

function githubHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "dep-diff-mcp",
	};
	if (token) headers["Authorization"] = `Bearer ${token}`;
	return headers;
}

async function fetchReleaseByTag(
	owner: string, repo: string, version: string, token?: string
): Promise<any | null> {
	const clean = semver.coerce(version)?.version ?? version;
	const candidates = [`v${clean}`, clean, `${repo}-${clean}`, `v${version}`, version];
	const seen = new Set<string>();
	for (const tag of candidates) {
		if (seen.has(tag)) continue;
		seen.add(tag);
		const key = `release:${owner}/${repo}/${tag}`;
		const cachedHit = cache.get(key);
		if (cachedHit) return cachedHit;
		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
			{ headers: githubHeaders(token) }
		);
		if (res.ok) {
			const rel = await res.json();
			cache.set(key, rel as object);
			return rel;
		}
	}
	return null;
}

const MAX_UNVERSIONED_RELEASES = 10;

export function filterReleasesInRange(releases: any[], from: string, to: string): any[] {
	// coerce() drops the prerelease component, so "5.0.0-alpha.3" would otherwise
	// compare equal to "5.0.0" and fall inside a 4.18.2 -> 5.0.0 range.
	const parsedFrom = semver.coerce(from, { includePrerelease: true });
	const parsedTo = semver.coerce(to, { includePrerelease: true });

	const base = [...releases];
	if (!parsedFrom || !parsedTo) return base.slice(0, MAX_UNVERSIONED_RELEASES);

	// Moving between two stable versions: the alphas and betas in between were
	// never released to this user, so they are not part of the upgrade.
	const endpointsAreStable =
		parsedFrom.prerelease.length === 0 && parsedTo.prerelease.length === 0;

	return base.filter((r) => {
		const parsed = semver.coerce(r.tag_name, { includePrerelease: true });
		if (!parsed) return false;
		if (endpointsAreStable && parsed.prerelease.length > 0) return false;
		return semver.gt(parsed, parsedFrom) && semver.lte(parsed, parsedTo);
	});
}

export class ReleaseFetchError extends Error {
	constructor(public readonly page: number, public readonly status: number) {
		super(`GitHub releases page ${page} returned ${status}`);
		this.name = "ReleaseFetchError";
	}
}

const MAX_RELEASE_PAGES = 5;
const RELEASES_PER_PAGE = 100;

interface PageResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

export async function collectReleasePages(
	fetchPage: (page: number) => Promise<PageResponse>,
	maxPages: number = MAX_RELEASE_PAGES
): Promise<any[]> {
	const out: any[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const res = await fetchPage(page);
		// Throwing rather than breaking is load-bearing: cached() only stores a
		// resolved value, so a rate-limited page can no longer be pinned as "this
		// repo has no releases" for the rest of the TTL.
		if (!res.ok) throw new ReleaseFetchError(page, res.status);
		const batch = (await res.json()) as any[];
		if (!Array.isArray(batch) || batch.length === 0) break;
		out.push(...batch);
		if (batch.length < RELEASES_PER_PAGE) break;
	}
	return out;
}

async function fetchReleasesBetween(
	owner: string, repo: string, from: string, to: string, token?: string
) {
	const allReleases = await cached(`releases:${owner}/${repo}`, () =>
		collectReleasePages((page) =>
			fetch(
				`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
				{ headers: githubHeaders(token) }
			)
		)
	);

	const filtered = filterReleasesInRange(allReleases, from, to);
	const cleanTo = semver.coerce(to)?.version;

	const hasTo = filtered.some((r) => {
		const v = semver.coerce(r.tag_name)?.version;
		return cleanTo && v === cleanTo;
	});
	if (!hasTo && cleanTo) {
		const toRelease = await fetchReleaseByTag(owner, repo, to, token).catch(() => null);
		if (toRelease) filtered.push(toRelease);
	}

	return filtered;
}

// ---------- CVE check via OSV.dev (free, no auth, all ecosystems) ----------

async function fetchCvesAtVersion(ecosystem: Ecosystem, name: string, version: string) {
	const cleanVersion = semver.coerce(version)?.version ?? version;
	return cached(`osv:${ecosystem}:${name}:${cleanVersion}`, async () => {
		const res = await fetch("https://api.osv.dev/v1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] },
				version: cleanVersion,
			}),
		});
		if (!res.ok) return [] as any[];
		const data = (await res.json()) as { vulns?: any[] };
		return data.vulns ?? [];
	});
}

// Package-only OSV query, for ecosystems where OSV cannot resolve a version itself.
async function fetchAllCves(ecosystem: Ecosystem, name: string) {
	return cached(`osv-all:${ecosystem}:${name}`, async () => {
		const res = await fetch("https://api.osv.dev/v1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] } }),
		});
		if (!res.ok) return [] as any[];
		const data = (await res.json()) as { vulns?: any[] };
		return data.vulns ?? [];
	});
}

// ---------- Breaking change extraction ----------

const BREAKING_HEADER = /(?:^|\n)#{1,4}\s*(?:breaking changes?|breaking|💥|🚨|⚠️)/i;

const STRONG_BULLET = new RegExp(
	"^[\\s]*[-*+][\\s]+" +
	"(?:\\*\\*)?" +
	"(?:breaking[:\\s]|removed?\\b|drop(?:ped|s)?\\s+support|" +
	"no\\s+longer\\b|now\\s+requires?\\b|renamed?\\b|" +
	"deprecated\\b|replaced?\\b|migrated?\\b|" +
	"incompatible\\b|changed?\\s+(?:behavior|default|signature)|" +
	"minimum\\s+(?:node|python|version))",
	"im"
);

// Release-note bullets that describe CI, tests, docs, or tooling. These match the
// STRONG_BULLET verbs ("remove", "replace", "deprecated") without being API changes.
const CHORE_BULLET = new RegExp(
	"^(?:chore|ci|test|docs?|build|style|refactor|perf)(?:\\([^)]*\\))?:|" +
	"\\bci\\b|appveyor|\\bgha\\b|github\\s+actions|workflow|" +
	"\\blint(?:ing|er)?\\b|jsdoc|\\btypos?\\b|\\btests?\\b|testing|coverage|" +
	"readme|changelog|contributing|dependabot|codecov|benchmark",
	"i"
);

// The verb that made a line match STRONG_BULLET, so it can be stripped to see
// whether anything of substance is left ("remove:" -> nothing).
const BULLET_KEYWORD = new RegExp(
	"^(?:breaking|removed?|drop(?:ped|s)?\\s+support|no\\s+longer|now\\s+requires?|" +
	"renamed?|deprecated|replaced?|migrated?|incompatible|" +
	"changed?\\s+(?:behavior|default|signature)|minimum\\s+(?:node|python|version))",
	"i"
);

function isSubstantiveBullet(text: string): boolean {
	if (CHORE_BULLET.test(text)) return false;
	const remainder = text.replace(BULLET_KEYWORD, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	return remainder.length > 0;
}

const MAX_BULLETS_PER_RELEASE = 10;
const MAX_BULLET_LEN = 300;
const MAX_SECTION_LEN = 800;

// GitHub's generated release notes close every line with an attribution that says
// nothing about what broke: "... by @someone in https://github.com/o/r/pull/123".
const ATTRIBUTION = /\s*[([]?\s*(?:(?:by\s+)?@[\w-]+\s+in\s+)?https?:\/\/github\.com\/\S+?\/pull\/\d+\s*[)\]]?\s*$/i;

function trimLine(line: string, max: number): string {
	const clean = line
		.trim()
		.replace(/^[-*+]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(ATTRIBUTION, "")
		.trim();
	return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

// The marker that makes a heading a breaking-change heading. Whatever follows it
// is the change itself: `### ⚠️ String length counts code points` needs no body.
const BREAKING_MARKER = /^\s*(?:💥|🚨|⚠️|breaking\s+changes?|breaking)\s*[:–—-]*\s*/i;

const HEADING_LINE = /^#{1,4}\s+(.*)$/;

const MAX_SECTIONS_PER_RELEASE = 5;

/** Body text under a heading, minus the churn, as one capped line. */
const BULLET_LINE = /^\s*[-*+]\s+/;
const MAX_SECTION_ENTRY_LEN = 240;

/**
 * A "Breaking Changes" heading is usually a list, not a paragraph: each bullet is
 * one change, and the prose under it carries the detail that matters. Real case,
 * actions/setup-node v5.0.0 -- the bullet says "Upgrade action to use node24" and
 * the sentence beneath it says the runner must be v2.327.1 or later. Condensing
 * the section into a single string buried that at the end of a run-on paragraph.
 *
 * Split on the bullets, keep each one's prose with it, and return one entry per
 * change. A section with no bullets is genuinely a paragraph, so it condenses.
 */
function splitSectionEntries(lines: string[]): string[] {
	const prose = stripFences(lines);
	if (!prose.some((l) => BULLET_LINE.test(l))) {
		const single = condenseLines(prose);
		return single ? [single] : [];
	}

	const chunks: string[][] = [];
	for (const line of prose) {
		if (BULLET_LINE.test(line)) chunks.push([line]);
		else if (chunks.length > 0) chunks[chunks.length - 1]!.push(line);
	}

	const out: string[] = [];
	for (const chunk of chunks) {
		const text = condenseLines(chunk, MAX_SECTION_ENTRY_LEN);
		if (text && !CHORE_BULLET.test(text)) out.push(text);
	}
	return out;
}

/** A fenced block is configuration or sample code, not a statement of what broke. */
function stripFences(lines: string[]): string[] {
	const out: string[] = [];
	let fenced = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) out.push(line);
	}
	return out;
}

function condenseLines(lines: string[], max: number = MAX_SECTION_LEN): string {
	const kept = lines
		.map((l) => l.trim().replace(/^[-*+]\s*/, "").replace(/\*\*/g, "").replace(ATTRIBUTION, "").trim())
		.filter((l) => l.length > 0 && !CHORE_BULLET.test(l));
	if (kept.length === 0) return "";
	const joined = kept
		.map((l, i) => (i === kept.length - 1 || /[.!?:;]$/.test(l) ? l : l + "."))
		.join(" ");
	return joined.length > max ? joined.slice(0, max) + "…" : joined;
}

function condenseSection(lines: string[]): string {
	// A fenced block is configuration or sample code, not a statement of what broke,
	// and joining it into one line makes the rest unreadable.
	const prose: string[] = [];
	let fenced = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) prose.push(line);
	}

	const kept = prose
		.map((l) => l.trim().replace(/^[-*+]\s*/, "").replace(/\*\*/g, "").replace(ATTRIBUTION, "").trim())
		.filter((l) => l.length > 0 && !CHORE_BULLET.test(l));
	if (kept.length === 0) return "";
	// Space-joining two unpunctuated lines reads as one broken sentence
	// ("...caching is automatic Upgrade the action..."), so supply the boundary.
	const joined = kept
		.map((l, i) => (i === kept.length - 1 || /[.!?:;]$/.test(l) ? l : l + "."))
		.join(" ");
	return joined.length > MAX_SECTION_LEN ? joined.slice(0, MAX_SECTION_LEN) + "…" : joined;
}

/**
 * Walk the headings and keep the ones marked breaking.
 *
 * The previous version tested for a breaking *heading* but then searched for the
 * bare word "breaking" anywhere in the body, so a release whose real breaking
 * changes sat under `### ⚠️` headings could return an unrelated changelog line
 * that happened to contain the word — and drop every actual change. Guard and
 * extraction now anchor on the same match.
 */
function extractBreakingSections(body: string, tag: string): string[] {
	const out: string[] = [];
	const lines = body.split(/\r?\n/);

	let current: string | null = null;
	let buffer: string[] = [];

	const flush = () => {
		if (current === null) return;
		const title = current.replace(BREAKING_MARKER, "").replace(/[\s#]+$/, "").trim();
		if (title) {
			if (!CHORE_BULLET.test(title)) out.push(`${tag}: ${title}`);
		} else {
			for (const text of splitSectionEntries(buffer)) out.push(`${tag}: ${text}`);
		}
		current = null;
		buffer = [];
	};

	for (const line of lines) {
		const heading = line.match(HEADING_LINE);
		if (!heading) {
			if (current !== null) buffer.push(line);
			continue;
		}
		flush();
		if (out.length >= MAX_SECTIONS_PER_RELEASE) return out;
		const text = heading[1]!.trim();
		if (BREAKING_MARKER.test(text)) current = text;
	}
	flush();
	return out.slice(0, MAX_SECTIONS_PER_RELEASE);
}

export function extractBreakingChanges(releases: any[]): string[] {
	const breaking: string[] = [];
	for (const rel of releases) {
		const body: string = rel.body ?? "";
		const tag = rel.tag_name ?? rel.name ?? "unknown";

		if (BREAKING_HEADER.test(body)) {
			breaking.push(...extractBreakingSections(body, tag));
		} else if (/breaking/i.test(rel.name ?? "")) {
			// The release itself is announced as breaking but carries no heading to
			// anchor on, so the body as a whole is the best available answer.
			const excerpt = condenseSection(body.split(/\r?\n/));
			if (excerpt) breaking.push(`${tag}: ${excerpt}`);
		}

		// One entry per change. Joining several onto one line made the count wrong
		// and left the reader splitting on a pipe.
		let bullets = 0;
		for (const line of body.split(/\r?\n/)) {
			if (!STRONG_BULLET.test(line)) continue;
			const text = trimLine(line, MAX_BULLET_LEN);
			if (!isSubstantiveBullet(text)) continue;
			breaking.push(`${tag}: ${text}`);
			if (++bullets >= MAX_BULLETS_PER_RELEASE) break;
		}
	}
	// A bullet under a breaking heading is found by the section split and by the
	// bullet scan alike, which reported the same change twice and doubled the count.
	return [...new Set(breaking)];
}

const MAX_EXCERPT_RELEASES = 5;
const MAX_EXCERPT_LEN = 500;

export function extractReleaseExcerpts(releases: any[]): { tag: string; excerpt: string }[] {
	const sorted = [...releases].sort((a: any, b: any) => {
		const ta = new Date(a.published_at ?? 0).getTime();
		const tb = new Date(b.published_at ?? 0).getTime();
		return tb - ta;
	});
	const top = sorted.slice(0, MAX_EXCERPT_RELEASES);
	return top
		.map((rel: any) => {
			const body: string = (rel.body ?? "").trim();
			if (!body) return null;
			const excerpt = body.length > MAX_EXCERPT_LEN ? body.slice(0, MAX_EXCERPT_LEN) + "…" : body;
			return { tag: rel.tag_name ?? rel.name ?? "unknown", excerpt };
		})
		.filter((x): x is { tag: string; excerpt: string } => x !== null);
}

export function extractMigrationLinks(releases: any[]): string[] {
	const links = new Set<string>();
	const linkRegex = /\[([^\]]*(?:migration|upgrade guide|upgrading)[^\]]*)\]\(([^)]+)\)/gi;
	for (const rel of releases) {
		const body: string = rel.body ?? "";
		let m;
		while ((m = linkRegex.exec(body)) !== null) {
			if (m[2]) links.add(m[2]);
		}
	}
	return [...links];
}

// ---------- Recommendation logic (the "intelligent" part) ----------

function generateRecommendation(
	semverClass: PackageAnalysis["semverClass"],
	breaking: string[],
	fixedCves: any[]
): { text: string; level: PackageAnalysis["recommendationLevel"] } {
	if (fixedCves.length > 0) {
		const sev = fixedCves.some((c: any) => /critical|high/i.test(c.database_specific?.severity ?? ""));
		return {
			text: `RECOMMENDED: ${fixedCves.length} security fix(es)${sev ? " (incl. high/critical)" : ""}.`,
			level: "security",
		};
	}
	if (semverClass === "downgrade") {
		return { text: `WARNING: This is a downgrade. Verify intentional.`, level: "caution" };
	}
	if (semverClass === "major") {
		return {
			text: breaking.length > 0
				? `CAUTION: Major version with ${breaking.length} breaking change(s) noted in release notes.`
				: `REVIEW: Major version bump. Breaking changes possible even if not explicitly listed.`,
			level: "caution",
		};
	}
	if (breaking.length > 0) {
		return { text: `REVIEW: ${breaking.length} breaking change(s) noted despite non-major bump.`, level: "review" };
	}
	if (semverClass === "minor") {
		return { text: `LIKELY SAFE: Minor version, additive changes per semver.`, level: "likely-safe" };
	}
	return { text: `SAFE: Patch-level change.`, level: "safe" };
}

// ---------- The orchestrator ----------

export async function analyzePackageChange(
	ecosystem: Ecosystem,
	name: string,
	fromVersion: string,
	toVersion: string,
	githubToken?: string
): Promise<PackageAnalysis> {
	const semverClass = classifyBump(fromVersion, toVersion);

	// A GitHub Actions reference is already a repo coordinate, so there is no
	// registry to look it up in.
	const repo =
		ecosystem === "github-actions"
			? parseActionRepo(name)
			: extractGitHubRepo(
					ecosystem === "npm" ? await fetchNpmMeta(name) : await fetchPyPIMeta(name),
					ecosystem
				);

	const releasesPromise = repo
		? fetchReleasesBetween(repo.owner, repo.repo, fromVersion, toVersion, githubToken).catch(() => [])
		: Promise.resolve([] as any[]);

	let fixedCves: any[];
	let releases: any[];
	if (ecosystem === "github-actions") {
		// OSV has no version enumeration here, so a versioned query returns nothing.
		const [rel, allCves] = await Promise.all([
			releasesPromise,
			fetchAllCves(ecosystem, name).catch(() => [] as any[]),
		]);
		releases = rel;
		fixedCves = selectFixedCves(allCves, name, fromVersion, toVersion);
	} else {
		const [rel, cvesAtFrom, cvesAtTo] = await Promise.all([
			releasesPromise,
			fetchCvesAtVersion(ecosystem, name, fromVersion).catch(() => []),
			fetchCvesAtVersion(ecosystem, name, toVersion).catch(() => []),
		]);
		releases = rel;
		const toIds = new Set(cvesAtTo.map((c: any) => c.id));
		fixedCves = cvesAtFrom.filter((c: any) => !toIds.has(c.id));
	}

	const breakingChanges = extractBreakingChanges(releases);
	const migrationLinks = extractMigrationLinks(releases);
	const rec = generateRecommendation(semverClass, breakingChanges, fixedCves);

	const needsFallback = breakingChanges.length === 0 && (semverClass === "major" || semverClass === "minor");
	const releaseExcerpts = needsFallback ? extractReleaseExcerpts(releases) : undefined;

	const result: PackageAnalysis = {
		package: name,
		ecosystem,
		fromVersion,
		toVersion,
		semverClass,
		repoUrl: repo ? `https://github.com/${repo.owner}/${repo.repo}` : null,
		releaseCount: releases.length,
		breakingChanges,
		securityFixes: fixedCves.map((c: any) => ({
			id: c.id,
			summary: c.summary ?? c.details?.slice(0, 200) ?? "",
			severity: c.database_specific?.severity ?? "unknown",
		})),
		migrationLinks,
		recommendation: rec.text,
		recommendationLevel: rec.level,
	};
	if (releaseExcerpts && releaseExcerpts.length > 0) {
		result.releaseExcerpts = releaseExcerpts;
	}
	return result;
}