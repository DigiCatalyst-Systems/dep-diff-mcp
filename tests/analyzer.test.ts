import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyBump,
	extractGitHubRepo,
	extractBreakingChanges,
	extractMigrationLinks,
	extractReleaseExcerpts,
	filterReleasesInRange,
	collectReleasePages,
	parseActionRepo,
	isVersionAffected,
	selectFixedCves,
	ReleaseFetchError,
} from "../src/analyzer.ts";

describe("classifyBump", () => {
	it("classifies major bumps", () => {
		assert.equal(classifyBump("1.0.0", "2.0.0"), "major");
		assert.equal(classifyBump("18.2.0", "19.0.0"), "major");
	});

	it("classifies minor bumps", () => {
		assert.equal(classifyBump("1.2.0", "1.3.0"), "minor");
		assert.equal(classifyBump("4.17.0", "4.18.0"), "minor");
	});

	it("classifies patch bumps", () => {
		assert.equal(classifyBump("1.0.0", "1.0.1"), "patch");
		assert.equal(classifyBump("4.17.20", "4.17.21"), "patch");
	});

	it("classifies equal versions as patch", () => {
		assert.equal(classifyBump("1.0.0", "1.0.0"), "patch");
	});

	it("classifies downgrades", () => {
		assert.equal(classifyBump("2.0.0", "1.0.0"), "downgrade");
		assert.equal(classifyBump("1.2.3", "1.2.2"), "downgrade");
	});

	it("returns unknown for garbage input", () => {
		assert.equal(classifyBump("not-a-version", "also-not"), "unknown");
		assert.equal(classifyBump("", ""), "unknown");
	});

	it("coerces tag-style versions", () => {
		assert.equal(classifyBump("v1.0.0", "v2.0.0"), "major");
		assert.equal(classifyBump("1", "2"), "major");
	});

	it("treats premajor as major", () => {
		assert.equal(classifyBump("1.0.0", "2.0.0-beta.1"), "major");
	});
});

describe("extractGitHubRepo", () => {
	it("extracts from npm repository string", () => {
		const meta = { repository: "https://github.com/lodash/lodash" };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "lodash", repo: "lodash" });
	});

	it("extracts from npm repository object with url", () => {
		const meta = { repository: { url: "git+https://github.com/vercel/next.js.git" } };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "vercel", repo: "next.js" });
	});

	it("preserves dots in repo names (regression: vercel/next.js not vercel/next)", () => {
		const meta = { repository: { url: "https://github.com/vercel/next.js" } };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "vercel", repo: "next.js" });
	});

	it("preserves dashes in repo names", () => {
		const meta = { repository: "https://github.com/lodash-es/lodash-es" };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "lodash-es", repo: "lodash-es" });
	});

	it("falls back to homepage when repository is missing", () => {
		const meta = { homepage: "https://github.com/facebook/react" };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "facebook", repo: "react" });
	});

	it("falls back to bugs url", () => {
		const meta = { bugs: { url: "https://github.com/axios/axios/issues" } };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "axios", repo: "axios" });
	});

	it("handles git ssh URL form", () => {
		const meta = { repository: { url: "git@github.com:expressjs/express.git" } };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "expressjs", repo: "express" });
	});

	it("extracts from PyPI project_urls Source", () => {
		const meta = { info: { project_urls: { Source: "https://github.com/psf/requests" } } };
		assert.deepEqual(extractGitHubRepo(meta, "pypi"), { owner: "psf", repo: "requests" });
	});

	it("extracts from PyPI home_page as last resort", () => {
		const meta = { info: { home_page: "https://github.com/pallets/flask" } };
		assert.deepEqual(extractGitHubRepo(meta, "pypi"), { owner: "pallets", repo: "flask" });
	});

	it("returns null when no GitHub URL is present", () => {
		assert.equal(extractGitHubRepo({ homepage: "https://example.com" }, "npm"), null);
		assert.equal(extractGitHubRepo({}, "npm"), null);
	});

	it("strips .git suffix", () => {
		const meta = { repository: { url: "https://github.com/nodejs/node.git" } };
		assert.deepEqual(extractGitHubRepo(meta, "npm"), { owner: "nodejs", repo: "node" });
	});
});

describe("extractBreakingChanges", () => {
	it("returns empty array for empty input", () => {
		assert.deepEqual(extractBreakingChanges([]), []);
	});

	it("returns empty array when no breaking patterns are present", () => {
		const releases = [{ tag_name: "v1.1.0", body: "- Added foo\n- Improved bar" }];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});

	it("captures explicit Breaking Changes section", () => {
		const releases = [
			{
				tag_name: "v2.0.0",
				body: "## Breaking Changes\nDropped IE11 support.\n\n## Features\n- thing",
			},
		];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /v2\.0\.0 \(section\)/);
		assert.match(out[0]!, /Dropped IE11 support/);
	});

	it("captures strong bullet patterns without explicit section", () => {
		const releases = [
			{
				tag_name: "v3.0.0",
				body: "Release notes\n\n- Removed deprecated foo API\n- No longer supports Node 14\n- Now requires Python 3.10",
			},
		];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /v3\.0\.0 \(bullets\)/);
		assert.match(out[0]!, /Removed deprecated foo API/);
		assert.match(out[0]!, /No longer supports Node 14/);
		assert.match(out[0]!, /Now requires Python 3\.10/);
	});

	it("captures deprecated/renamed/dropped-support bullets", () => {
		const releases = [
			{
				tag_name: "v4.0.0",
				body: "- Deprecated old helper\n- Renamed foo to bar\n- Dropped support for Node 16",
			},
		];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Deprecated/);
		assert.match(out[0]!, /Renamed/);
		assert.match(out[0]!, /Dropped support/);
	});

	it("caps bullets per release", () => {
		const bullets = Array.from({ length: 25 }, (_, i) => `- Removed feature ${i}`).join("\n");
		const releases = [{ tag_name: "v1.0.0", body: bullets }];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		const bulletEntries = out[0]!.split(" | ");
		assert.ok(bulletEntries.length <= 10, `expected <= 10 bullets, got ${bulletEntries.length}`);
	});

	it("truncates long bullet lines", () => {
		const longText = "x".repeat(1000);
		const releases = [{ tag_name: "v1.0.0", body: `- Removed ${longText}` }];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.ok(out[0]!.includes("…"), "expected ellipsis truncation");
	});

	it("returns both section and bullet entries when both present", () => {
		const releases = [
			{
				tag_name: "v2.0.0",
				body: "## Breaking Changes\nSome top-level change.\n\n## Other\n- Removed foo\n- No longer supports bar",
			},
		];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 2);
		assert.ok(out.some((e) => e.includes("(section)")));
		assert.ok(out.some((e) => e.includes("(bullets)")));
	});

	// zod v4.5.0 flags five real breaking changes with emoji headings, then mentions
	// the word "breaking" 53kB later inside a docs commit line. Anchoring extraction
	// on the bare word rather than the heading returned the docs line and discarded
	// all five.
	it("anchors on the heading, not a stray mention of the word", () => {
		const body = [
			"## What's new",
			"- added a thing",
			"",
			"### ⚠️ `z.iso.datetime()` requires seconds",
			"Datetimes without seconds are now rejected.",
			"",
			"### ⚠️ `__proto__` is always stripped",
			"Declared `__proto__` keys become own properties.",
			"",
			"## Commits",
			"- [`e177a0ee`](https://x) docs(v4): document coerce missing-key breaking change",
		].join("\n");
		const out = extractBreakingChanges([{ tag_name: "v4.5.0", body }]);
		assert.equal(out.length, 2);
		assert.match(out[0]!, /`z\.iso\.datetime\(\)` requires seconds/);
		assert.match(out[1]!, /__proto__` is always stripped/);
		assert.ok(
			!out.some((e) => /docs\(v4\)/.test(e)),
			`docs commit leaked into output: ${JSON.stringify(out)}`
		);
	});

	it("uses the heading title as the change when it carries one", () => {
		const body = "### 💥 Minimum Node is now 20\nSee the migration guide.";
		const out = extractBreakingChanges([{ tag_name: "v3.0.0", body }]);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Minimum Node is now 20/);
	});

	it("falls back to the section body for a marker-only heading", () => {
		const body = "## Breaking\nThe `parse` option was removed.\n\n## Other";
		const out = extractBreakingChanges([{ tag_name: "v2.0.0", body }]);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /The `parse` option was removed/);
	});

	it("skips a breaking heading whose content is only chores", () => {
		const body = "## ⚠️ CI changes\n- ci: bump the workflow runner\n- chore: update dependabot config";
		assert.deepEqual(extractBreakingChanges([{ tag_name: "v1.2.0", body }]), []);
	});

	it("stops a section at the next heading of any level", () => {
		const body = "## Breaking\nOnly this line.\n### Details\nNot this one.";
		const out = extractBreakingChanges([{ tag_name: "v2.0.0", body }]);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Only this line/);
		assert.ok(!/Not this one/.test(out[0]!), out[0]);
	});

	it("truncates a long section rather than emitting a wall of text", () => {
		const body = `## Breaking\n${"word ".repeat(500)}`;
		const out = extractBreakingChanges([{ tag_name: "v2.0.0", body }]);
		assert.equal(out.length, 1);
		assert.ok(out[0]!.length < 900, `section not capped: ${out[0]!.length}`);
		assert.ok(out[0]!.endsWith("…"), "expected ellipsis truncation");
	});

	// Release notes generated by GitHub end every line with an attribution that
	// carries no information about what broke.
	it("strips trailing author and pull request attribution", () => {
		const body =
			"- Remove always-auth configuration handling by @priyagupta108 in https://github.com/actions/setup-node/pull/1436";
		const out = extractBreakingChanges([{ tag_name: "v6.1.0", body }]);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Remove always-auth configuration handling$/);
	});

	it("strips a bare pull request link with no author", () => {
		const body = "- Removed the legacy parser (https://github.com/x/y/pull/12)";
		const out = extractBreakingChanges([{ tag_name: "v2.0.0", body }]);
		assert.match(out[0]!, /Removed the legacy parser$/);
	});

	it("strips attribution that omits the leading \"by\"", () => {
		const body =
			"- Remove hardcoded bearer for mirror-url @marco-ippolito in https://github.com/actions/setup-node/pull/1467";
		const out = extractBreakingChanges([{ tag_name: "v6.3.0", body }]);
		assert.match(out[0]!, /Remove hardcoded bearer for mirror-url$/);
	});

	it("drops fenced code blocks from a section", () => {
		const body = [
			"## ⚠️",
			"Caching is now automatic. To disable it, set the option:",
			"```yaml",
			"steps:",
			"  - uses: actions/setup-node@v5",
			"```",
			"That is the whole change.",
		].join("\n");
		const out = extractBreakingChanges([{ tag_name: "v5.0.0", body }]);
		assert.equal(out.length, 1);
		assert.ok(!/uses:/.test(out[0]!), `code block leaked: ${out[0]}`);
		assert.match(out[0]!, /Caching is now automatic/);
	});

	it("keeps a link that is part of the sentence", () => {
		const body = "- Removed the old API, see https://example.com/migration for details";
		const out = extractBreakingChanges([{ tag_name: "v2.0.0", body }]);
		assert.match(out[0]!, /see https:\/\/example\.com\/migration for details/);
	});

	it("ignores non-breaking bullets", () => {
		const releases = [
			{
				tag_name: "v1.5.0",
				body: "- Added new feature\n- Improved performance\n- Fixed typo",
			},
		];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});
});

describe("extractMigrationLinks", () => {
	it("returns empty array for no links", () => {
		assert.deepEqual(extractMigrationLinks([]), []);
		assert.deepEqual(extractMigrationLinks([{ body: "just text" }]), []);
	});

	it("extracts migration guide links", () => {
		const releases = [
			{ body: "See the [migration guide](https://example.com/migrate) for details." },
		];
		assert.deepEqual(extractMigrationLinks(releases), ["https://example.com/migrate"]);
	});

	it("extracts upgrade guide variants", () => {
		const releases = [
			{ body: "[upgrade guide](https://a.com)" },
			{ body: "[Upgrading to v5](https://b.com)" },
		];
		const out = extractMigrationLinks(releases);
		assert.ok(out.includes("https://a.com"));
		assert.ok(out.includes("https://b.com"));
	});

	it("deduplicates repeated links", () => {
		const releases = [
			{ body: "[migration](https://same.com)" },
			{ body: "[migration guide](https://same.com)" },
		];
		assert.deepEqual(extractMigrationLinks(releases), ["https://same.com"]);
	});

	it("ignores non-migration links", () => {
		const releases = [{ body: "[random link](https://random.com) [blog post](https://blog.com)" }];
		assert.deepEqual(extractMigrationLinks(releases), []);
	});
});

describe("extractReleaseExcerpts", () => {
	it("returns empty array for no releases", () => {
		assert.deepEqual(extractReleaseExcerpts([]), []);
	});

	it("skips releases with empty body", () => {
		const releases = [{ tag_name: "v1.0.0", body: "" }, { tag_name: "v1.1.0", body: "   " }];
		assert.deepEqual(extractReleaseExcerpts(releases), []);
	});

	it("returns most recent releases by published_at", () => {
		const releases = [
			{ tag_name: "v1.0.0", body: "oldest", published_at: "2020-01-01T00:00:00Z" },
			{ tag_name: "v2.0.0", body: "newest", published_at: "2025-01-01T00:00:00Z" },
			{ tag_name: "v1.5.0", body: "middle", published_at: "2023-01-01T00:00:00Z" },
		];
		const out = extractReleaseExcerpts(releases);
		assert.equal(out[0]?.tag, "v2.0.0");
		assert.equal(out[1]?.tag, "v1.5.0");
		assert.equal(out[2]?.tag, "v1.0.0");
	});

	it("caps at 5 excerpts", () => {
		const releases = Array.from({ length: 10 }, (_, i) => ({
			tag_name: `v${i}.0.0`,
			body: `body ${i}`,
			published_at: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
		}));
		const out = extractReleaseExcerpts(releases);
		assert.equal(out.length, 5);
	});

	it("truncates long bodies with ellipsis", () => {
		const longBody = "a".repeat(1000);
		const releases = [{ tag_name: "v1.0.0", body: longBody, published_at: "2025-01-01T00:00:00Z" }];
		const out = extractReleaseExcerpts(releases);
		assert.ok(out[0]!.excerpt.endsWith("…"));
		assert.ok(out[0]!.excerpt.length <= 501);
	});

	it("does not truncate short bodies", () => {
		const releases = [{ tag_name: "v1.0.0", body: "short", published_at: "2025-01-01T00:00:00Z" }];
		const out = extractReleaseExcerpts(releases);
		assert.equal(out[0]?.excerpt, "short");
	});
});

describe("filterReleasesInRange", () => {
	const rel = (tag: string) => ({ tag_name: tag, body: "" });

	it("keeps stable releases inside the range", () => {
		const releases = [rel("v4.18.2"), rel("v4.18.3"), rel("v4.20.0"), rel("v5.0.0"), rel("v5.1.0")];
		const out = filterReleasesInRange(releases, "4.18.2", "5.0.0").map((r) => r.tag_name);
		assert.deepEqual(out, ["v4.18.3", "v4.20.0", "v5.0.0"]);
	});

	it("excludes prerelease tags when both endpoints are stable", () => {
		const releases = [
			rel("v4.20.0"),
			rel("5.0.0-alpha.1"),
			rel("5.0.0-alpha.7"),
			rel("5.0.0-beta.2"),
			rel("v5.0.0"),
		];
		const out = filterReleasesInRange(releases, "4.18.2", "5.0.0").map((r) => r.tag_name);
		assert.deepEqual(out, ["v4.20.0", "v5.0.0"]);
	});

	it("keeps prereleases when the target version is itself a prerelease", () => {
		const releases = [rel("v4.20.0"), rel("5.0.0-alpha.1"), rel("5.0.0-beta.2"), rel("v5.0.0")];
		const out = filterReleasesInRange(releases, "4.18.2", "5.0.0-beta.2").map((r) => r.tag_name);
		assert.deepEqual(out, ["v4.20.0", "5.0.0-alpha.1", "5.0.0-beta.2"]);
	});

	it("keeps prereleases when the starting version is a prerelease", () => {
		const releases = [rel("5.0.0-alpha.1"), rel("5.0.0-beta.2"), rel("v5.0.0")];
		const out = filterReleasesInRange(releases, "5.0.0-alpha.1", "5.0.0").map((r) => r.tag_name);
		assert.deepEqual(out, ["5.0.0-beta.2", "v5.0.0"]);
	});

	it("handles repo-prefixed tags", () => {
		const releases = [rel("express-4.19.0"), rel("express-5.0.0-alpha.1")];
		const out = filterReleasesInRange(releases, "4.18.2", "5.0.0").map((r) => r.tag_name);
		assert.deepEqual(out, ["express-4.19.0"]);
	});

	it("drops tags that cannot be parsed as versions", () => {
		const releases = [rel("nightly"), rel("v4.19.0")];
		const out = filterReleasesInRange(releases, "4.18.2", "5.0.0").map((r) => r.tag_name);
		assert.deepEqual(out, ["v4.19.0"]);
	});

	it("falls back to the 10 most recent releases when versions are unparseable", () => {
		const releases = Array.from({ length: 20 }, (_, i) => rel(`v1.${i}.0`));
		const out = filterReleasesInRange(releases, "garbage", "also-garbage");
		assert.equal(out.length, 10);
	});
});

describe("extractBreakingChanges — noise filtering", () => {
	it("drops bullets with no substance after the keyword", () => {
		const releases = [{ tag_name: "5.0.0-alpha.3", body: "- remove:\n- removed:\n- Deprecated" }];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});

	it("drops CI, build, and test chore bullets", () => {
		const releases = [
			{
				tag_name: "v5.0.0",
				body: [
					"- Replace Appveyor windows testing with GHA by @jonchurch in https://github.com/expressjs/express/pull/5599",
					"- remove minor version pinning from ci by @jonchurch in https://github.com/expressjs/express/pull/5722",
					"- remove duplicate location test for data uri by @wesleytodd in https://github.com/expressjs/express/pull/5562",
				].join("\n"),
			},
		];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});

	it("drops docs and changelog chore bullets", () => {
		const releases = [
			{
				tag_name: "v5.0.0",
				body: [
					'- replace "replaces" with "replacer" in jsdoc by @apeltop in https://github.com/expressjs/express/pull/4843',
					"- docs: removed outdated example from README",
					"- chore: deprecated lint rule removed",
				].join("\n"),
			},
		];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});

	it("keeps genuine API breaking changes alongside chore noise", () => {
		const releases = [
			{
				tag_name: "v5.0.0",
				body: [
					"- Deprecated API methods removed: Removed old, deprecated API method signatures from Express v3/v4.",
					"- Replace Appveyor windows testing with GHA by @jonchurch in https://github.com/expressjs/express/pull/5599",
					"- Remove `debug` dependency",
				].join("\n"),
			},
		];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Deprecated API methods removed/);
		assert.match(out[0]!, /Remove `debug` dependency/);
		assert.doesNotMatch(out[0]!, /Appveyor/);
	});

	it("omits a breaking-changes section whose body is empty", () => {
		const releases = [{ tag_name: "v0.32.0", body: "## Breaking Changes\n\n## Features\n- Added thing" }];
		assert.deepEqual(extractBreakingChanges(releases), []);
	});

	it("still emits a section when the heading has real content", () => {
		const releases = [{ tag_name: "v2.0.0", body: "## Breaking Changes\nDropped IE11 support.\n" }];
		const out = extractBreakingChanges(releases);
		assert.equal(out.length, 1);
		assert.match(out[0]!, /Dropped IE11 support/);
	});
});

describe("collectReleasePages", () => {
	const page = (count: number, ok = true, status = 200) => ({
		ok,
		status,
		json: async () => Array.from({ length: count }, (_, i) => ({ tag_name: `v0.0.${i}` })),
	});

	it("returns the releases from a single short page", async () => {
		const out = await collectReleasePages(async () => page(3));
		assert.equal(out.length, 3);
	});

	it("follows pagination until a short page", async () => {
		const pages = [page(100), page(100), page(7)];
		const out = await collectReleasePages(async (n) => pages[n - 1]!);
		assert.equal(out.length, 207);
	});

	it("stops after maxPages", async () => {
		let calls = 0;
		const out = await collectReleasePages(async () => { calls++; return page(100); }, 3);
		assert.equal(calls, 3);
		assert.equal(out.length, 300);
	});

	it("returns an empty array when the repo genuinely has no releases", async () => {
		const out = await collectReleasePages(async () => page(0));
		assert.deepEqual(out, []);
	});

	it("treats a non-array body as the end of the list", async () => {
		const out = await collectReleasePages(async () => ({
			ok: true, status: 200, json: async () => ({ message: "not an array" }),
		}));
		assert.deepEqual(out, []);
	});

	// The bug: a rate-limited first page returned [], which the caller then cached
	// for an hour as if the repo had no releases.
	it("throws when the first page fails instead of returning empty", async () => {
		await assert.rejects(
			() => collectReleasePages(async () => page(0, false, 403)),
			(e: unknown) => e instanceof ReleaseFetchError && (e as ReleaseFetchError).status === 403
		);
	});

	it("throws rather than returning partial results when a later page fails", async () => {
		const pages = [page(100), page(0, false, 403)];
		await assert.rejects(
			() => collectReleasePages(async (n) => pages[n - 1]!),
			(e: unknown) => e instanceof ReleaseFetchError && (e as ReleaseFetchError).page === 2
		);
	});
});

describe("parseActionRepo", () => {
	it("reads owner and repo from an action reference", () => {
		assert.deepEqual(parseActionRepo("actions/checkout"), { owner: "actions", repo: "checkout" });
	});

	it("drops the subdirectory of a nested action", () => {
		assert.deepEqual(parseActionRepo("github/codeql-action/init"), {
			owner: "github",
			repo: "codeql-action",
		});
	});

	it("rejects a bare package name", () => {
		assert.equal(parseActionRepo("lodash"), null);
	});

	it("rejects an npm scoped package", () => {
		assert.equal(parseActionRepo("@actions/core"), null);
	});

	it("rejects an empty segment", () => {
		assert.equal(parseActionRepo("actions/"), null);
		assert.equal(parseActionRepo("/checkout"), null);
	});
});

// OSV has no version enumeration for the "GitHub Actions" ecosystem, so a query
// carrying a version returns nothing. Ranges have to be evaluated here instead.
describe("isVersionAffected", () => {
	const changedFiles = {
		id: "GHSA-mrrh-fwg8-r2c3",
		affected: [
			{
				package: { name: "tj-actions/changed-files", ecosystem: "GitHub Actions" },
				ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "46.0.1" }] }],
			},
		],
	};

	it("reports a version below the fix as affected", () => {
		assert.equal(isVersionAffected(changedFiles, "tj-actions/changed-files", "45.0.7"), true);
	});

	it("reports the fixed version itself as unaffected", () => {
		assert.equal(isVersionAffected(changedFiles, "tj-actions/changed-files", "46.0.1"), false);
		assert.equal(isVersionAffected(changedFiles, "tj-actions/changed-files", "46.0.2"), false);
	});

	it("coerces bare major tags on both sides", () => {
		const vuln = {
			affected: [
				{
					package: { name: "tj-actions/changed-files", ecosystem: "GitHub Actions" },
					ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "41" }] }],
				},
			],
		};
		assert.equal(isVersionAffected(vuln, "tj-actions/changed-files", "40"), true);
		assert.equal(isVersionAffected(vuln, "tj-actions/changed-files", "v40"), true);
		assert.equal(isVersionAffected(vuln, "tj-actions/changed-files", "41"), false);
	});

	it("honours the introduced bound", () => {
		const vuln = {
			affected: [
				{
					package: { name: "some/action", ecosystem: "GitHub Actions" },
					ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0.0" }, { fixed: "3.0.0" }] }],
				},
			],
		};
		assert.equal(isVersionAffected(vuln, "some/action", "1.9.0"), false);
		assert.equal(isVersionAffected(vuln, "some/action", "2.0.0"), true);
		assert.equal(isVersionAffected(vuln, "some/action", "2.5.0"), true);
	});

	it("treats a range with no fix as affected without an upper bound", () => {
		const vuln = {
			affected: [
				{
					package: { name: "some/action", ecosystem: "GitHub Actions" },
					ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "1.0.0" }] }],
				},
			],
		};
		assert.equal(isVersionAffected(vuln, "some/action", "99.0.0"), true);
	});

	it("ignores affected entries for a different package", () => {
		assert.equal(isVersionAffected(changedFiles, "actions/checkout", "1.0.0"), false);
	});

	it("falls back to an explicit versions list when present", () => {
		const vuln = {
			affected: [
				{
					package: { name: "some/action", ecosystem: "GitHub Actions" },
					versions: ["1.0.0", "1.0.1"],
				},
			],
		};
		assert.equal(isVersionAffected(vuln, "some/action", "1.0.1"), true);
		assert.equal(isVersionAffected(vuln, "some/action", "1.0.2"), false);
	});

	it("returns false for an unparseable version", () => {
		assert.equal(isVersionAffected(changedFiles, "tj-actions/changed-files", "main"), false);
	});
});

describe("selectFixedCves", () => {
	const vuln = (id: string, fixed: string) => ({
		id,
		affected: [
			{
				package: { name: "tj-actions/changed-files", ecosystem: "GitHub Actions" },
				ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed }] }],
			},
		],
	});
	const vulns = [vuln("GHSA-old", "41"), vuln("GHSA-new", "46.0.1")];

	it("keeps advisories the upgrade actually resolves", () => {
		const fixed = selectFixedCves(vulns, "tj-actions/changed-files", "45.0.7", "46.0.1");
		assert.deepEqual(fixed.map((v) => v.id), ["GHSA-new"]);
	});

	it("drops advisories that still apply after the upgrade", () => {
		const fixed = selectFixedCves(vulns, "tj-actions/changed-files", "40", "45.0.7");
		assert.deepEqual(fixed.map((v) => v.id), ["GHSA-old"]);
	});

	it("returns nothing when the old version was never affected", () => {
		assert.deepEqual(selectFixedCves(vulns, "tj-actions/changed-files", "46.0.1", "47"), []);
	});

	it("returns both when the bump clears every advisory", () => {
		const fixed = selectFixedCves(vulns, "tj-actions/changed-files", "40", "46.0.1");
		assert.deepEqual(fixed.map((v) => v.id), ["GHSA-old", "GHSA-new"]);
	});
});
