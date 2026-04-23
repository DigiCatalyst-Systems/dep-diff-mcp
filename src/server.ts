#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import { createMcpServer } from "./index.js";

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

const server = createMcpServer(resolveGitHubToken());
const transport = new StdioServerTransport();
await server.connect(transport);
