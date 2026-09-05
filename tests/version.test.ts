import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SERVER_VERSION } from "../src/version.js";

describe("SERVER_VERSION", () => {
	it("matches the version in package.json", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8")
		);
		assert.equal(
			SERVER_VERSION,
			pkg.version,
			`src/version.ts says ${SERVER_VERSION} but package.json says ${pkg.version}. ` +
				"Bump src/version.ts whenever the package version changes."
		);
	});
});
