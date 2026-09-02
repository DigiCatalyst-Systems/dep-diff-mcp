import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerHandler, { resolveTokenFromRequest, resolveToken } from "../src/worker.ts";

function req(url: string): Request {
	return new Request(url);
}

function b64(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1" },
	},
};

function rpcRequest(url: string, body: unknown = INITIALIZE): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});
}

/** Transport replies as either plain JSON or an SSE `data:` frame. */
async function readRpc(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	const frame = text.match(/^data: (.+)$/m);
	return JSON.parse(frame ? frame[1] : text) as Record<string, unknown>;
}

describe("resolveTokenFromRequest", () => {
	it("returns undefined when no token is supplied", () => {
		assert.equal(resolveTokenFromRequest(req("https://example.com/mcp")), undefined);
	});

	it("reads token from ?githubToken= query param", () => {
		assert.equal(
			resolveTokenFromRequest(req("https://example.com/mcp?githubToken=ghp_abc123")),
			"ghp_abc123"
		);
	});

	it("trims whitespace from direct query param", () => {
		assert.equal(
			resolveTokenFromRequest(req("https://example.com/mcp?githubToken=%20ghp_abc%20")),
			"ghp_abc"
		);
	});

	it("treats empty direct token as absent", () => {
		assert.equal(resolveTokenFromRequest(req("https://example.com/mcp?githubToken=")), undefined);
	});

	it("reads token from base64 ?config= blob", () => {
		const url = `https://example.com/mcp?config=${encodeURIComponent(b64({ githubToken: "ghp_xyz" }))}`;
		assert.equal(resolveTokenFromRequest(req(url)), "ghp_xyz");
	});

	it("direct query param wins over config blob", () => {
		const url = `https://example.com/mcp?githubToken=direct&config=${encodeURIComponent(b64({ githubToken: "fromConfig" }))}`;
		assert.equal(resolveTokenFromRequest(req(url)), "direct");
	});

	it("returns undefined for malformed config blob", () => {
		assert.equal(
			resolveTokenFromRequest(req("https://example.com/mcp?config=not-base64!")),
			undefined
		);
	});

	it("returns undefined when config blob lacks githubToken", () => {
		const url = `https://example.com/mcp?config=${encodeURIComponent(b64({ otherField: "x" }))}`;
		assert.equal(resolveTokenFromRequest(req(url)), undefined);
	});

	it("returns undefined when config githubToken is empty string", () => {
		const url = `https://example.com/mcp?config=${encodeURIComponent(b64({ githubToken: "" }))}`;
		assert.equal(resolveTokenFromRequest(req(url)), undefined);
	});
});

describe("worker fetch handler", () => {
	it("GET / returns JSON descriptor", async () => {
		const res = await workerHandler.fetch(new Request("https://example.com/"));
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		const body = (await res.json()) as { name?: string; endpoint?: string };
		assert.equal(body.name, "dep-diff-mcp");
		assert.equal(body.endpoint, "/mcp");
	});

	it("GET /health returns descriptor", async () => {
		const res = await workerHandler.fetch(new Request("https://example.com/health"));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { name?: string };
		assert.equal(body.name, "dep-diff-mcp");
	});

	it("POST / answers JSON-RPC instead of the descriptor", async () => {
		const res = await workerHandler.fetch(rpcRequest("https://example.com/"));
		assert.equal(res.status, 200);
		const body = await readRpc(res);
		assert.equal(body.jsonrpc, "2.0");
		const result = body.result as { serverInfo?: { name?: string } } | undefined;
		assert.equal(result?.serverInfo?.name, "dep-diff");
	});

	// A fresh transport is built per request, so there is no session to stream
	// notifications from. Refuse the stream instead of holding one open forever.
	it("GET / negotiating SSE is refused with 405", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/", { headers: { Accept: "text/event-stream" } })
		);
		assert.equal(res.status, 405);
		assert.match(res.headers.get("allow") ?? "", /POST/);
	});

	it("GET /mcp negotiating SSE is refused with 405", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/mcp", { headers: { Accept: "text/event-stream" } })
		);
		assert.equal(res.status, 405);
		assert.match(res.headers.get("allow") ?? "", /POST/);
	});

	it("DELETE / is not answered with the descriptor", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/", { method: "DELETE" })
		);
		const text = await res.text();
		assert.ok(!text.includes("dep-diff-mcp"), `descriptor leaked to DELETE: ${text.slice(0, 120)}`);
	});

	it("unknown path returns 404", async () => {
		const res = await workerHandler.fetch(new Request("https://example.com/nope"));
		assert.equal(res.status, 404);
	});

	it("/.well-known/mcp/server-card.json returns the Smithery card with tools, prompts, and annotations", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/.well-known/mcp/server-card.json")
		);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		const card = (await res.json()) as {
			serverInfo?: { name?: string };
			tools?: {
				name: string;
				annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
			}[];
			prompts?: { name: string }[];
		};
		assert.equal(card.serverInfo?.name, "dep-diff");

		assert.ok(card.tools?.some((t) => t.name === "analyze_package_change"));
		assert.ok(card.tools?.some((t) => t.name === "analyze_packages_bulk"));
		for (const t of card.tools ?? []) {
			assert.equal(t.annotations?.readOnlyHint, true, `${t.name} needs readOnlyHint`);
			assert.equal(t.annotations?.openWorldHint, true, `${t.name} needs openWorldHint`);
		}

		assert.ok(card.prompts?.some((p) => p.name === "review_dependabot_pr"));
		assert.ok(card.prompts?.some((p) => p.name === "explain_package_upgrade"));
	});
});

describe("resolveToken (request token, then operator secret)", () => {
	it("uses the caller's token when both are present, so they spend their own budget", () => {
		assert.equal(
			resolveToken(req("https://example.com/mcp?githubToken=ghp_caller"), { GITHUB_TOKEN: "ghp_operator" }),
			"ghp_caller"
		);
	});

	it("falls back to the operator secret when the request carries no token", () => {
		assert.equal(
			resolveToken(req("https://example.com/mcp"), { GITHUB_TOKEN: "ghp_operator" }),
			"ghp_operator"
		);
	});

	it("falls back to the operator secret behind a config blob with no token", () => {
		const url = `https://example.com/mcp?config=${b64({ somethingElse: true })}`;
		assert.equal(resolveToken(req(url), { GITHUB_TOKEN: "ghp_operator" }), "ghp_operator");
	});

	it("returns undefined when neither is present", () => {
		assert.equal(resolveToken(req("https://example.com/mcp"), {}), undefined);
	});

	it("tolerates a missing env entirely", () => {
		assert.equal(resolveToken(req("https://example.com/mcp")), undefined);
		assert.equal(resolveToken(req("https://example.com/mcp?githubToken=ghp_abc")), "ghp_abc");
	});

	it("trims whitespace from the operator secret", () => {
		assert.equal(resolveToken(req("https://example.com/mcp"), { GITHUB_TOKEN: "  ghp_op  " }), "ghp_op");
	});

	it("treats an empty operator secret as absent", () => {
		assert.equal(resolveToken(req("https://example.com/mcp"), { GITHUB_TOKEN: "   " }), undefined);
		assert.equal(resolveToken(req("https://example.com/mcp"), { GITHUB_TOKEN: "" }), undefined);
	});
});
