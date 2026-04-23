import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./index.js";

function resolveTokenFromRequest(request: Request): string | undefined {
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
					config: {
						githubToken: "optional; pass via Smithery config or ?githubToken= query param",
					},
				}),
				{ headers: { "Content-Type": "application/json" } }
			);
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
