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

const SERVER_CARD = {
	serverInfo: {
		name: "dep-diff",
		version: "0.1.6",
	},
	authentication: {
		required: false,
	},
	tools: [
		{
			name: "analyze_package_change",
			description:
				"Given one package and two versions (from -> to), returns a structured upgrade analysis: semver classification, GitHub release notes summary, detected breaking changes, security advisories fixed in the range, migration guide links, and a clear recommendation. Use when the user asks about a specific package upgrade. Supports npm and pypi. For analyzing many packages at once, use analyze_packages_bulk instead.",
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
		},
		{
			name: "analyze_packages_bulk",
			description:
				"Analyzes a list of package upgrades in parallel and returns a unified risk report with packages ranked by recommendation level (security > caution > review > likely-safe > safe). Use when the user provides many dependency changes from a Dependabot PR, npm outdated output, lockfile diff, or batch upgrade. Returns: total count, breakdown by semver class, total security fixes found, packages with breaking changes, and per-package details. Limit 50 packages per call.",
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
		},
	],
	resources: [],
	prompts: [],
} as const;

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					name: "dep-diff-mcp",
					description: "Translates a lockfile diff into a human-readable upgrade plan for npm and PyPI.",
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

		if (url.pathname !== "/mcp") {
			return new Response("Not Found", { status: 404 });
		}

		try {
			const token = resolveTokenFromRequest(request);
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
