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

describe("tool output schemas", () => {
	type ToolEntry = { outputSchema?: { parse: (v: unknown) => unknown } };
	const registry = () =>
		(createMcpServer() as unknown as { _registeredTools: Record<string, ToolEntry> })
			._registeredTools;

	// Real analyze_package_change output for lodash 4.17.20 -> 4.17.21, as published
	// in the README. Kept verbatim so the schema is checked against shipped output.
	const lodashAnalysis = {
		package: "lodash",
		ecosystem: "npm",
		fromVersion: "4.17.20",
		toVersion: "4.17.21",
		semverClass: "patch",
		repoUrl: "https://github.com/lodash/lodash",
		releaseCount: 0,
		breakingChanges: [],
		securityFixes: [
			{
				id: "GHSA-29mw-wpgm-hmr9",
				summary: "Regular Expression Denial of Service (ReDoS) in lodash",
				severity: "MODERATE",
			},
			{ id: "GHSA-35jh-r3h4-6jhm", summary: "Command Injection in lodash", severity: "HIGH" },
		],
		migrationLinks: [],
		recommendation: "RECOMMENDED: 2 security fix(es) (incl. high/critical).",
		recommendationLevel: "security",
	};

	it("analyze_package_change declares an output schema", () => {
		const t = registry()["analyze_package_change"];
		assert.ok(t?.outputSchema, "analyze_package_change must declare outputSchema");
	});

	it("analyze_packages_bulk declares an output schema", () => {
		const t = registry()["analyze_packages_bulk"];
		assert.ok(t?.outputSchema, "analyze_packages_bulk must declare outputSchema");
	});

	it("accepts a real single-package analysis", () => {
		const schema = registry()["analyze_package_change"]?.outputSchema;
		assert.ok(schema, "outputSchema missing");
		schema.parse(lodashAnalysis);
	});

	it("accepts an analysis carrying releaseExcerpts", () => {
		const schema = registry()["analyze_package_change"]?.outputSchema;
		assert.ok(schema, "outputSchema missing");
		schema.parse({
			...lodashAnalysis,
			repoUrl: null,
			releaseExcerpts: [{ tag: "v5.0.0", excerpt: "Dropped Node 14 support." }],
		});
	});

	it("accepts a null repoUrl (package with no resolvable repository)", () => {
		const schema = registry()["analyze_package_change"]?.outputSchema;
		assert.ok(schema, "outputSchema missing");
		schema.parse({ ...lodashAnalysis, repoUrl: null });
	});

	it("accepts a bulk summary whose packages[] holds a full analysis", () => {
		const schema = registry()["analyze_packages_bulk"]?.outputSchema;
		assert.ok(schema, "outputSchema missing");
		schema.parse({
			totalPackages: 1,
			bySemverClass: { major: 0, minor: 0, patch: 1 },
			securityFixesTotal: 2,
			packagesWithBreakingChanges: 0,
			packages: [lodashAnalysis],
		});
	});

	it("accepts a bulk summary whose packages[] holds a partial-failure entry", () => {
		// A rejected analysis pushes {package, error, recommendationLevel} rather than
		// a full PackageAnalysis. Without this the SDK rejects otherwise-good calls.
		const schema = registry()["analyze_packages_bulk"]?.outputSchema;
		assert.ok(schema, "outputSchema missing");
		schema.parse({
			totalPackages: 2,
			bySemverClass: { major: 0, minor: 0, patch: 1 },
			securityFixesTotal: 2,
			packagesWithBreakingChanges: 0,
			packages: [
				lodashAnalysis,
				{ package: "left-pad", error: "registry lookup failed", recommendationLevel: "review" },
			],
		});
	});
});
