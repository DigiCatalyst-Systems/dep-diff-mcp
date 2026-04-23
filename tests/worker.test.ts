import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerHandler, { resolveTokenFromRequest } from "../src/worker.ts";

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

	it("/.well-known/mcp/server-card.json returns the Smithery card", async () => {
		const res = await workerHandler.fetch(
			new Request("https://example.com/.well-known/mcp/server-card.json")
		);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		const card = (await res.json()) as {
			serverInfo?: { name?: string };
			tools?: { name: string }[];
		};
		assert.equal(card.serverInfo?.name, "dep-diff");
		assert.ok(card.tools?.some((t) => t.name === "analyze_package_change"));
		assert.ok(card.tools?.some((t) => t.name === "analyze_packages_bulk"));
	});
});
