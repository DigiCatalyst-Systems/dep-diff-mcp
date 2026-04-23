import semver from "semver";
import { LRUCache } from "lru-cache";

export type Ecosystem = "npm" | "pypi";

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

export interface PackageAnalysis {
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
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };

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

async function fetchReleasesBetween(
	owner: string, repo: string, from: string, to: string, token?: string
) {
	const allReleases = await cached(`releases:${owner}/${repo}`, async () => {
		const out: any[] = [];
		for (let page = 1; page <= 5; page++) {
			const res = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
				{ headers: githubHeaders(token) }
			);
			if (!res.ok) break;
			const batch = (await res.json()) as any[];
			if (!Array.isArray(batch) || batch.length === 0) break;
			out.push(...batch);
			if (batch.length < 100) break;
		}
		return out;
	});

	const cleanFrom = semver.coerce(from)?.version;
	const cleanTo = semver.coerce(to)?.version;

	const base = [...allReleases];
	let filtered: any[];
	if (!cleanFrom || !cleanTo) {
		filtered = base.slice(0, 10);
	} else {
		filtered = base.filter((r) => {
			const v = semver.coerce(r.tag_name)?.version;
			if (!v) return false;
			return semver.gt(v, cleanFrom) && semver.lte(v, cleanTo);
		});
	}

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

const MAX_BULLETS_PER_RELEASE = 10;
const MAX_BULLET_LEN = 300;
const MAX_SECTION_LEN = 800;

function trimLine(line: string, max: number): string {
	const clean = line.trim().replace(/^[-*+]\s*/, "").replace(/\*\*/g, "");
	return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

export function extractBreakingChanges(releases: any[]): string[] {
	const breaking: string[] = [];
	for (const rel of releases) {
		const body: string = rel.body ?? "";
		const tag = rel.tag_name ?? rel.name ?? "unknown";

		if (BREAKING_HEADER.test(body) || /breaking/i.test(rel.name ?? "")) {
			const m = body.match(/(?:breaking changes?|breaking)[^\n]*\n([\s\S]+?)(?=\n#{1,4}|$)/i);
			const excerpt = m?.[1]?.trim().slice(0, MAX_SECTION_LEN) ?? "(see full release notes)";
			breaking.push(`${tag} (section): ${excerpt}`);
		}

		const bullets: string[] = [];
		for (const line of body.split(/\r?\n/)) {
			if (STRONG_BULLET.test(line)) {
				bullets.push(trimLine(line, MAX_BULLET_LEN));
				if (bullets.length >= MAX_BULLETS_PER_RELEASE) break;
			}
		}
		if (bullets.length > 0) {
			breaking.push(`${tag} (bullets): ${bullets.join(" | ")}`);
		}
	}
	return breaking;
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

	const meta = ecosystem === "npm" ? await fetchNpmMeta(name) : await fetchPyPIMeta(name);
	const repo = extractGitHubRepo(meta, ecosystem);

	const [releases, cvesAtFrom, cvesAtTo] = await Promise.all([
		repo
			? fetchReleasesBetween(repo.owner, repo.repo, fromVersion, toVersion, githubToken).catch(() => [])
			: Promise.resolve([]),
		fetchCvesAtVersion(ecosystem, name, fromVersion).catch(() => []),
		fetchCvesAtVersion(ecosystem, name, toVersion).catch(() => []),
	]);

	const toIds = new Set(cvesAtTo.map((c: any) => c.id));
	const fixedCves = cvesAtFrom.filter((c: any) => !toIds.has(c.id));

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