import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pLimit from "p-limit";
import { analyzePackageChange, type Ecosystem } from "./analyzer.js";

export const configSchema = z.object({
	githubToken: z
		.string()
		.optional()
		.describe(
			"GitHub personal access token (ghp_... or github_pat_...) for higher API rate limits. Optional; without it, GitHub API is rate-limited to 60 requests/hour."
		),
});

const limit = pLimit(8);
const ecosystemSchema = z.enum(["npm", "pypi"]).describe("Package ecosystem");

export function createMcpServer(githubToken?: string): McpServer {
	const server = new McpServer({
		name: "dep-diff",
		version: "0.1.9",
	});

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
			annotations: {
				title: "Analyze a single dependency version change",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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
			annotations: {
				title: "Analyze multiple dependency changes in parallel",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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

				const analyzed = results.map((r, i) =>
					r.status === "fulfilled"
						? r.value
						: {
							package: changes[i]?.name ?? "unknown",
							error: (r.reason as Error).message,
							recommendationLevel: "review" as const,
						}
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

	server.registerPrompt(
		"review_dependabot_pr",
		{
			title: "Review a Dependabot or batch upgrade PR",
			description:
				"Generates a user message instructing the model to analyze a list of dependency " +
				"changes, then call analyze_packages_bulk to produce a ranked risk report.",
			argsSchema: {
				ecosystem: z.enum(["npm", "pypi"]).describe("Package ecosystem"),
				changes: z
					.string()
					.describe(
						"Raw list of changes, one per line, formatted as 'name from_version -> to_version'. Example:\nlodash 4.17.20 -> 4.17.21\naxios 0.27.0 -> 1.7.0"
					),
			},
		},
		({ ecosystem, changes }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `I have a Dependabot/batch upgrade with the following ${ecosystem} package changes:\n\n${changes}\n\nParse each line into {ecosystem, name, fromVersion, toVersion}, call analyze_packages_bulk with the list, and give me a ranked risk summary. Highlight anything with security fixes or major breaking changes first.`,
					},
				},
			],
		})
	);

	server.registerPrompt(
		"explain_package_upgrade",
		{
			title: "Explain a single package upgrade",
			description:
				"Generates a user message asking the model to analyze a specific package version bump " +
				"and explain the risk.",
			argsSchema: {
				ecosystem: z.enum(["npm", "pypi"]).describe("Package ecosystem"),
				name: z.string().describe("Package name"),
				fromVersion: z.string().describe("Current version"),
				toVersion: z.string().describe("Target version"),
			},
		},
		({ ecosystem, name, fromVersion, toVersion }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Analyze the upgrade of ${ecosystem} package "${name}" from ${fromVersion} to ${toVersion}. Call analyze_package_change, then summarize: semver class, breaking changes, security fixes, migration steps, and your recommendation. Be concise.`,
					},
				},
			],
		})
	);

	return server;
}

export default function ({ config }: { config: z.infer<typeof configSchema> }) {
	return createMcpServer(config.githubToken).server;
}

export function createSandboxServer() {
	return createMcpServer(undefined).server;
}
