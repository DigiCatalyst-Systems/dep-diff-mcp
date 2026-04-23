import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import defaultExport, { createMcpServer, createSandboxServer, configSchema } from "../src/index.ts";

describe("createMcpServer", () => {
	it("returns an McpServer instance", () => {
		const s = createMcpServer();
		assert.ok(s instanceof McpServer, "expected an McpServer");
	});

	it("accepts an optional GitHub token", () => {
		const s = createMcpServer("ghp_test");
		assert.ok(s instanceof McpServer);
	});

	it("registers analyze_package_change and analyze_packages_bulk tools", () => {
		const s = createMcpServer();
		const tools = (s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
		assert.ok(tools, "server should expose a tool registry");
		assert.ok("analyze_package_change" in tools, "analyze_package_change must be registered");
		assert.ok("analyze_packages_bulk" in tools, "analyze_packages_bulk must be registered");
	});

	it("registers review_dependabot_pr and explain_package_upgrade prompts", () => {
		const s = createMcpServer();
		const prompts = (s as unknown as { _registeredPrompts: Record<string, unknown> })._registeredPrompts;
		assert.ok(prompts, "server should expose a prompt registry");
		assert.ok("review_dependabot_pr" in prompts, "review_dependabot_pr must be registered");
		assert.ok("explain_package_upgrade" in prompts, "explain_package_upgrade must be registered");
	});

	it("tools include annotations (readOnlyHint, idempotentHint, openWorldHint)", () => {
		const s = createMcpServer();
		const tools = (s as unknown as {
			_registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
		})._registeredTools;
		for (const name of ["analyze_package_change", "analyze_packages_bulk"]) {
			const t = tools[name];
			assert.ok(t?.annotations, `${name} must have annotations`);
			assert.equal(t.annotations.readOnlyHint, true, `${name} readOnlyHint must be true`);
			assert.equal(t.annotations.idempotentHint, true, `${name} idempotentHint must be true`);
			assert.equal(t.annotations.openWorldHint, true, `${name} openWorldHint must be true`);
		}
	});
});

describe("createSandboxServer", () => {
	it("returns a low-level Server (.server of an McpServer)", () => {
		const lowLevel = createSandboxServer();
		assert.ok(lowLevel, "must return a server instance");
		assert.equal(typeof lowLevel.connect, "function", "server must expose connect()");
	});
});

describe("default export (Smithery factory)", () => {
	it("returns a low-level Server when called with config", () => {
		const lowLevel = defaultExport({ config: { githubToken: "ghp_test" } });
		assert.ok(lowLevel);
		assert.equal(typeof lowLevel.connect, "function");
	});

	it("accepts config with no token", () => {
		const lowLevel = defaultExport({ config: {} });
		assert.ok(lowLevel);
	});
});

describe("configSchema", () => {
	it("accepts empty object", () => {
		const parsed = configSchema.parse({});
		assert.equal(parsed.githubToken, undefined);
	});

	it("accepts a githubToken string", () => {
		const parsed = configSchema.parse({ githubToken: "ghp_abc" });
		assert.equal(parsed.githubToken, "ghp_abc");
	});

	it("rejects non-string githubToken", () => {
		assert.throws(() => configSchema.parse({ githubToken: 123 }));
	});

	it("ignores unknown fields (does not throw by default)", () => {
		const parsed = configSchema.parse({ githubToken: "ghp_x", extra: "ignored" }) as {
			githubToken?: string;
		};
		assert.equal(parsed.githubToken, "ghp_x");
	});
});
