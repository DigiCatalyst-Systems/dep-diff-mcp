/**
 * Version advertised to MCP clients in the handshake and in the Worker's server card.
 *
 * `rootDir` is `./src`, so package.json cannot be imported from here without
 * pulling it into the build output. tests/version.test.ts fails if this drifts
 * from package.json instead -- the same mirror-plus-test arrangement that keeps
 * packageAnalysisShape in step with PackageAnalysis.
 */
export const SERVER_VERSION = "0.3.2";
