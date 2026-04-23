import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./index.js";

export interface Env {
	GITHUB_TOKEN?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "/health") {
			return new Response(
				JSON.stringify({
					name: "dep-diff-mcp",
					description: "Translates a lockfile diff into a human-readable upgrade plan for npm and PyPI.",
					transport: "streamable-http",
					endpoint: "/mcp",
				}),
				{ headers: { "Content-Type": "application/json" } }
			);
		}

		if (url.pathname !== "/mcp") {
			return new Response("Not Found", { status: 404 });
		}

		try {
			const server = createMcpServer(env.GITHUB_TOKEN);
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
