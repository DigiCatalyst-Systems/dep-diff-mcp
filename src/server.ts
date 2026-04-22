#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pLimit from "p-limit";
import { execFileSync } from "node:child_process";
import { analyzePackageChange, type Ecosystem } from "./analyzer.js";

const limit = pLimit(8);

const server = new McpServer({
	name: "dep-diff",
	version: "0.1.0",
});

function resolveGitHubToken(): string | undefined {
	const envToken = process.env.GITHUB_TOKEN?.trim();
	if (envToken) return envToken;
	try {
		const ghToken = execFileSync("gh", ["auth", "token"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		if (ghToken) {
			process.stderr.write("[dep-diff] Using token from `gh auth token`.\n");
			return ghToken;
		}
	} catch {
		// gh not installed or not authed; fall through to anonymous mode
	}
	process.stderr.write(
		"[dep-diff] No GITHUB_TOKEN set and `gh` CLI unavailable. Running anonymous (60 req/hr).\n"
	);
	return undefined;
}

const ecosystemSchema = z.enum(["npm", "pypi"]).describe("Package ecosystem");
const githubToken = resolveGitHubToken();

server.registerTool(
	"analyze_package_change",
	{
		title: "Analyze a single dependency version change",
		description:
			"Given one package and two versions (from -> to), returns a structured upgrade analysis: " +
			"semver classification, GitHub release notes summary, detected breaking changes, security " +
			"advisories fixed in the range, migration guide links, and a clear recommendation. " +
			"Use when the user asks about a specific package upgrade ('what changed between react 18 and 19', " +
			"'is it safe to bump axios from 0.27 to 1.0', 'what does upgrading lodash 4.17.20 to 4.17.21 fix'). " +
			"Supports npm and pypi. For analyzing many packages at once or a Dependabot batch, " +
			"use analyze_packages_bulk instead.",
		inputSchema: {
			ecosystem: ecosystemSchema,
			name: z.string().min(1).describe("Package name (e.g. 'react', 'requests')"),
			fromVersion: z.string().min(1).describe("Current version (e.g. '18.2.0')"),
			toVersion: z.string().min(1).describe("Target version (e.g. '19.0.0')"),
		},
	},
	async ({ ecosystem, name, fromVersion, toVersion }) => {
		try {
			const result = await analyzePackageChange(
				ecosystem as Ecosystem, name, fromVersion, toVersion, githubToken
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Failed to analyze ${name}: ${err.message}` }],
				isError: true,
			};
		}
	}
);

server.registerTool(
	"analyze_packages_bulk",
	{
		title: "Analyze multiple dependency changes in parallel",
		description:
			"Analyzes a list of package upgrades in parallel and returns a unified risk report with " +
			"packages ranked by recommendation level (security > caution > review > likely-safe > safe). " +
			"Use when the user provides many dependency changes from a Dependabot PR, npm outdated output, " +
			"lockfile diff, or batch upgrade. Returns: total count, breakdown by semver class, total " +
			"security fixes found, packages with breaking changes, and per-package details. " +
			"Limit 50 packages per call (chunk larger lists).",
		inputSchema: {
			changes: z
				.array(
					z.object({
						ecosystem: ecosystemSchema,
						name: z.string().min(1),
						fromVersion: z.string().min(1),
						toVersion: z.string().min(1),
					})
				)
				.min(1)
				.max(50)
				.describe("List of package changes to analyze"),
		},
	},
	async ({ changes }) => {
		try {
			const results = await Promise.allSettled(
				changes.map((c) =>
					limit(() =>
						analyzePackageChange(c.ecosystem as Ecosystem, c.name, c.fromVersion, c.toVersion, githubToken)
					)
				)
			);

			const analyzed = results
				.map((r, i) =>
					r.status === "fulfilled"
						? r.value
						: { package: changes[i]?.name ?? "unknown", error: (r.reason as Error).message, recommendationLevel: "review" as const }
				);

			const ranks: Record<string, number> = { security: 0, caution: 1, review: 2, "likely-safe": 3, safe: 4 };
			const sorted = [...analyzed].sort(
				(a: any, b: any) => (ranks[a.recommendationLevel] ?? 5) - (ranks[b.recommendationLevel] ?? 5)
			);

			const summary = {
				totalPackages: changes.length,
				bySemverClass: {
					major: analyzed.filter((a: any) => a.semverClass === "major").length,
					minor: analyzed.filter((a: any) => a.semverClass === "minor").length,
					patch: analyzed.filter((a: any) => a.semverClass === "patch").length,
				},
				securityFixesTotal: analyzed.reduce(
					(n, a: any) => n + (a.securityFixes?.length ?? 0), 0
				),
				packagesWithBreakingChanges: analyzed.filter(
					(a: any) => (a.breakingChanges?.length ?? 0) > 0
				).length,
				packages: sorted,
			};

			return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Bulk analysis failed: ${err?.message ?? String(err)}` }],
				isError: true,
			};
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);