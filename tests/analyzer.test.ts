import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyBump,
	extractGitHubRepo,
	extractBreakingChanges,
	extractMigrationLinks,
	extractReleaseExcerpts,
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
