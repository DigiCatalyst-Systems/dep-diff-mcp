import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./index.js";

export function resolveTokenFromRequest(request: Request): string | undefined {
	const url = new URL(request.url);

	const direct = url.searchParams.get("githubToken");
	if (direct && direct.trim().length > 0) return direct.trim();

	const encoded = url.searchParams.get("config");
	if (encoded) {
		try {
			const decoded = atob(encoded);
			const parsed = JSON.parse(decoded) as { githubToken?: string };
			const token = parsed.githubToken?.trim();
			if (token && token.length > 0) return token;
		} catch {
			// malformed config blob; fall through to unauthenticated
		}
	}

	return undefined;
}

export interface Env {
	GITHUB_TOKEN?: string;
}

/**
 * The caller's own token wins so they spend their own 5,000/hr budget; the
 * operator secret is only a fallback. Without either, the Worker runs on
 * GitHub's 60/hr anonymous limit keyed to a shared Cloudflare egress IP, which
 * is exhausted almost immediately and makes packages look like they have no
 * releases.
 */
export function resolveToken(request: Request, env?: Env): string | undefined {
	const fromRequest = resolveTokenFromRequest(request);
	if (fromRequest) return fromRequest;
	const fromEnv = env?.GITHUB_TOKEN?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

// Mirrors the zod output schemas in index.ts. Smithery scores this card rather than
// the live tools/list, so the two have to be kept in step.
const PACKAGE_ANALYSIS_JSON_SCHEMA = {
	type: "object",
	properties: {
		package: { type: "string", description: "Package name that was analyzed" },
		ecosystem: { type: "string", enum: ["npm", "pypi"], description: "Package ecosystem" },
		fromVersion: { type: "string", description: "Version being upgraded from" },
		toVersion: { type: "string", description: "Version being upgraded to" },
		semverClass: {
			type: "string",
			enum: ["major", "minor", "patch", "downgrade", "unknown"],
			description: "Semver relationship between the two versions",
		},
		repoUrl: {
			type: ["string", "null"],
			description: "Source repository URL, or null when none could be resolved",
		},
		releaseCount: {
			type: "number",
			description: "Number of GitHub releases found strictly between the two versions",
		},
		breakingChanges: {
			type: "array",
			items: { type: "string" },
			description: "Breaking changes extracted from release notes; empty when none were found",
		},
		releaseExcerpts: {
			type: "array",
			description:
				"Raw release-note excerpts, present only as a fallback when a major/minor bump yielded no breaking changes",
			items: {
				type: "object",
				properties: {
					tag: { type: "string", description: "Release tag the excerpt came from" },
					excerpt: { type: "string", description: "Short excerpt of the release notes" },
				},
				required: ["tag", "excerpt"],
			},
		},
		securityFixes: {
			type: "array",
			description: "Advisories affecting fromVersion that are resolved at toVersion",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Advisory identifier (e.g. 'GHSA-29mw-wpgm-hmr9' or a CVE)" },
					summary: { type: "string", description: "One-line description of the advisory" },
					severity: {
						type: "string",
						description: "Severity as reported by OSV (e.g. 'LOW', 'MODERATE', 'HIGH', 'CRITICAL')",
					},
				},
				required: ["id", "summary", "severity"],
			},
		},
		migrationLinks: {
			type: "array",
			items: { type: "string" },
			description: "Migration or upgrade guide URLs found in release notes",
		},
		recommendation: { type: "string", description: "Single-line verdict explaining the recommendation level" },
		recommendationLevel: {
			type: "string",
			enum: ["safe", "likely-safe", "review", "caution", "security"],
			description: "Risk classification, used to rank packages in bulk results",
		},
	},
	required: [
		"package",
		"ecosystem",
		"fromVersion",
		"toVersion",
		"semverClass",
		"repoUrl",
		"releaseCount",
		"breakingChanges",
		"securityFixes",
		"migrationLinks",
		"recommendation",
		"recommendationLevel",
	],
};

const FAILED_ANALYSIS_JSON_SCHEMA = {
	type: "object",
	description: "A package whose analysis rejected, reported in place rather than dropped",
	properties: {
		package: { type: "string", description: "Package name whose analysis failed" },
		error: { type: "string", description: "Why the analysis could not be completed" },
		recommendationLevel: {
			type: "string",
			enum: ["review"],
			description:
				"Always 'review' — a package that could not be analyzed cannot be cleared automatically",
		},
	},
	required: ["package", "error", "recommendationLevel"],
};

const BULK_SUMMARY_JSON_SCHEMA = {
	type: "object",
	properties: {
		totalPackages: { type: "number", description: "Number of package changes submitted" },
		bySemverClass: {
			type: "object",
			description: "Breakdown of the batch by semver class",
			properties: {
				major: { type: "number", description: "Count of major bumps" },
				minor: { type: "number", description: "Count of minor bumps" },
				patch: { type: "number", description: "Count of patch bumps" },
			},
			required: ["major", "minor", "patch"],
		},
		securityFixesTotal: {
			type: "number",
			description: "Total security advisories resolved across the whole batch",
		},
		packagesWithBreakingChanges: {
			type: "number",
			description: "How many packages had at least one breaking change",
		},
		packages: {
			type: "array",
			description: "Per-package results, ranked security > caution > review > likely-safe > safe",
			items: { anyOf: [PACKAGE_ANALYSIS_JSON_SCHEMA, FAILED_ANALYSIS_JSON_SCHEMA] },
		},
	},
	required: [
		"totalPackages",
		"bySemverClass",
		"securityFixesTotal",
		"packagesWithBreakingChanges",
		"packages",
	],
};

const SERVER_CARD = {
	serverInfo: {
		name: "dep-diff",
		version: "0.2.3",
	},
	authentication: {
		required: false,
	},
	tools: [
		{
			name: "analyze_package_change",
			description:
				"Given one package and two versions (from -> to), returns a structured upgrade analysis: semver classification, GitHub release notes summary, detected breaking changes, security advisories fixed in the range, migration guide links, and a clear recommendation. Use when the user asks about a specific package upgrade. Supports npm and pypi. For analyzing many packages at once, use analyze_packages_bulk instead.",
			annotations: {
				title: "Analyze a single dependency version change",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					ecosystem: { type: "string", enum: ["npm", "pypi"], description: "Package ecosystem" },
					name: { type: "string", minLength: 1, description: "Package name (e.g. 'react', 'requests')" },
					fromVersion: { type: "string", minLength: 1, description: "Current version (e.g. '18.2.0')" },
					toVersion: { type: "string", minLength: 1, description: "Target version (e.g. '19.0.0')" },
				},
				required: ["ecosystem", "name", "fromVersion", "toVersion"],
			},
			outputSchema: PACKAGE_ANALYSIS_JSON_SCHEMA,
		},
		{
			name: "analyze_packages_bulk",
			description:
				"Analyzes a list of package upgrades in parallel and returns a unified risk report with packages ranked by recommendation level (security > caution > review > likely-safe > safe). Use when the user provides many dependency changes from a Dependabot PR, npm outdated output, lockfile diff, or batch upgrade. Returns: total count, breakdown by semver class, total security fixes found, packages with breaking changes, and per-package details. Limit 50 packages per call.",
			annotations: {
				title: "Analyze multiple dependency changes in parallel",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					changes: {
						type: "array",
						minItems: 1,
						maxItems: 50,
						description: "List of package changes to analyze",
						items: {
							type: "object",
							properties: {
								ecosystem: { type: "string", enum: ["npm", "pypi"] },
								name: { type: "string", minLength: 1 },
								fromVersion: { type: "string", minLength: 1 },
								toVersion: { type: "string", minLength: 1 },
							},
							required: ["ecosystem", "name", "fromVersion", "toVersion"],
						},
					},
				},
				required: ["changes"],
			},
			outputSchema: BULK_SUMMARY_JSON_SCHEMA,
		},
	],
	resources: [],
	prompts: [
		{
			name: "review_dependabot_pr",
			description:
				"Generates a user message instructing the model to analyze a list of dependency changes, then call analyze_packages_bulk to produce a ranked risk report.",
			arguments: [
				{ name: "ecosystem", description: "Package ecosystem (npm or pypi)", required: true },
				{
					name: "changes",
					description:
						"Raw list of changes, one per line, formatted as 'name from_version -> to_version'.",
					required: true,
				},
			],
		},
		{
			name: "explain_package_upgrade",
			description:
				"Generates a user message asking the model to analyze a specific package version bump and explain the risk.",
			arguments: [
				{ name: "ecosystem", description: "Package ecosystem (npm or pypi)", required: true },
				{ name: "name", description: "Package name", required: true },
				{ name: "fromVersion", description: "Current version", required: true },
				{ name: "toVersion", description: "Target version", required: true },
			],
		},
	],
} as const;

export default {
	async fetch(request: Request, env?: Env): Promise<Response> {
		const url = new URL(request.url);

		// Clients routinely address the base URL instead of /mcp. Serving the transport
		// there too avoids silently answering them with the descriptor. Only a plain
		// GET/HEAD on / is treated as discovery; POST, DELETE and SSE negotiation are
		// all real transport traffic.
		const wantsEventStream = (request.headers.get("accept") ?? "").includes("text/event-stream");
		const isDiscoveryProbe =
			(request.method === "GET" || request.method === "HEAD") && !wantsEventStream;
		const isTransportRequest =
			url.pathname === "/mcp" || (url.pathname === "/" && !isDiscoveryProbe);

		// A fresh server and transport are built per request, so no session survives to
		// push notifications down an SSE stream. Refuse it rather than holding a stream
		// open forever on a connection that can never deliver anything.
		if (isTransportRequest && wantsEventStream && (request.method === "GET" || request.method === "HEAD")) {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "POST, DELETE" },
			});
		}

		if (!isTransportRequest) {
			if (url.pathname === "/" || url.pathname === "/health") {
				return new Response(
					JSON.stringify({
						name: "dep-diff-mcp",
						description:
							"Translates a lockfile diff into a human-readable upgrade plan for npm and PyPI.",
						transport: "streamable-http",
						endpoint: "/mcp",
						serverCard: "/.well-known/mcp/server-card.json",
						config: {
							githubToken: "optional; pass via Smithery config or ?githubToken= query param",
						},
					}),
					{ headers: { "Content-Type": "application/json" } }
				);
			}

			if (url.pathname === "/.well-known/mcp/server-card.json") {
				return new Response(JSON.stringify(SERVER_CARD, null, 2), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": "public, max-age=300",
					},
				});
			}

			return new Response("Not Found", { status: 404 });
		}

		try {
			const token = resolveToken(request, env);
			const server = createMcpServer(token);
			const transport = new WebStandardStreamableHTTPServerTransport();
			await server.server.connect(transport);
			return await transport.handleRequest(request);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(
				JSON.stringify({ error: "Internal Server Error", detail: message }),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
		}
	},
};
