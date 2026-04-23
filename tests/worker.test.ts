import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerHandler, { resolveTokenFromRequest, extractAnalyticsEvent } from "../src/worker.ts";

function req(url: string): Request {
	return new Request(url);
}

function b64(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString("base64");
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

	it("unknown path returns 404", async () => {
		const res = await workerHandler.fetch(new Request("https://example.com/nope"));
		assert.equal(res.status, 404);
	});

	it("emits one analytics datapoint per /mcp POST with method + tool name", async () => {
		const points: unknown[] = [];
		const env = {
			ANALYTICS: {
				writeDataPoint: (p: unknown) => points.push(p),
			},
		};

		const req = new Request("https://example.com/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "analyze_package_change", arguments: {} },
			}),
		});

		await workerHandler.fetch(req, env as unknown as Parameters<typeof workerHandler.fetch>[1]);

		assert.equal(points.length, 1, "expected exactly one analytics event");
		const pt = points[0] as { blobs?: string[]; doubles?: number[]; indexes?: string[] };
		assert.deepEqual(pt.blobs, ["tools/call", "analyze_package_change"]);
		assert.deepEqual(pt.doubles, [1]);
		assert.deepEqual(pt.indexes, ["tools/call"]);
	});

	it("does not emit analytics when ANALYTICS binding is absent", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			})
		);
		assert.ok(res, "handler must still respond without analytics binding");
	});

	it("extractAnalyticsEvent parses method + params.name from JSON-RPC body", async () => {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", method: "prompts/get", params: { name: "review_dependabot_pr" } }),
		});
		const event = await extractAnalyticsEvent(req);
		assert.deepEqual(event, { method: "prompts/get", toolOrPromptName: "review_dependabot_pr" });
	});

	it("extractAnalyticsEvent returns null for GET", async () => {
		const event = await extractAnalyticsEvent(new Request("https://example.com/mcp"));
		assert.equal(event, null);
	});

	it("extractAnalyticsEvent handles missing params.name", async () => {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {} }),
		});
		const event = await extractAnalyticsEvent(req);
		assert.deepEqual(event, { method: "initialize", toolOrPromptName: "" });
	});

	it("extractAnalyticsEvent returns null for malformed body", async () => {
		const req = new Request("https://example.com/mcp", {
			method: "POST",
			body: "not-json",
		});
		const event = await extractAnalyticsEvent(req);
		assert.equal(event, null);
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
