# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Follow migration links and extract headings from linked upgrade guides.
- Ecosystem expansion: Cargo, go.mod, Maven.
- Lockfile-diff parser tool.

## [0.1.6] - 2026-04-23

### Added

- Worker serves `/.well-known/mcp/server-card.json` so Smithery's registry can skip live capability scanning (required when the scanner cannot introspect the endpoint automatically). Card advertises both tools with full inputSchema and authentication requirements.

## [0.1.5] - 2026-04-23

### Added

- Cloudflare Worker entry (`src/worker.ts`) exposing the server as streamable-HTTP, so the same factory can be hosted on free Cloudflare Workers and surfaced as a Smithery "Deploy via URL" endpoint.
- `.github/workflows/deploy-worker.yml`: auto-deploys the Worker on `main` pushes that touch worker code; uses `CLOUDFLARE_API_TOKEN` repo secret. Also manually dispatchable.
- `createSandboxServer()` export in `src/index.ts` so Smithery's capability scanner can introspect without real credentials.
- Tests: 10 cases for `src/index.ts` (factory, sandbox, default export, configSchema), 12 cases for `src/worker.ts` (token resolver + handler). 61 tests pass total.

### Changed

- Worker reads `GITHUB_TOKEN` per-request: `?githubToken=...` query param or base64-encoded `?config={...}`. No shared Worker secret — each user supplies their own token, individual rate limits.

## [0.1.4] - 2026-04-23

### Changed

- Split server construction from transport binding. `src/index.ts` now exports a `createMcpServer(token)` factory and a Smithery-compatible default export (`configSchema` + `default function({config})`). `src/server.ts` becomes a thin stdio launcher that calls the factory and binds `StdioServerTransport`.
- `package.json` gains a `module` field pointing to `dist/index.js` so Smithery's bundler can locate the streamable-http entry.

### Why

- Smithery deploys wrap MCP servers in a streamable-HTTP transport and need an exported factory, not a self-wiring stdio entry. The factory split lets both transports share one implementation without duplication.

## [0.1.3] - 2026-04-23

### Fixed

- `mcpName` in `package.json` and `name` in `server.json` now use `io.github.DigiCatalyst-Systems/...` with the correct GitHub organization casing (was lowercase). The MCP Registry enforces case-sensitive namespace ownership derived from GitHub org identity, so the lowercase form was rejected with a 403.

### Changed

- `server.json` description shortened to fit the registry's 100-character limit.

## [0.1.2] - 2026-04-23

### Added

- Test suite (`tests/analyzer.test.ts`) with 39 unit tests covering `classifyBump`, `extractGitHubRepo`, `extractBreakingChanges`, `extractMigrationLinks`, and `extractReleaseExcerpts`. Uses Node's built-in `node:test` runner plus `tsx` — zero new dependencies.
- `npm test` script.
- `.github/workflows/ci.yml` runs `npm ci && npm run build && npm test` on every push to `main` and every PR.

## [0.1.1] - 2026-04-22

### Added

- `mcpName` field in `package.json` and a root-level `server.json` so the package can be listed on the official MCP Registry (`io.github.digicatalyst-systems/dep-diff-mcp`).

### Changed

- First release published through CI via the `publish` GitHub Actions workflow using npm Trusted Publisher / OIDC. Tarballs now carry an npm provenance attestation.

## [0.1.0] - 2026-04-22

### Added

- `GITHUB_TOKEN` resolution falls back to `gh auth token` when the env var is unset. Users with the GitHub CLI authenticated get full API rate limits without a plaintext token in their MCP config. Stderr log line indicates which source was used (env, `gh`, or anonymous).
- Broader breaking-change detection. In addition to `## Breaking Changes` section excerpts, the analyzer now surfaces strong bullet patterns anywhere in release bodies: `- Removed X`, `- No longer Y`, `- Now requires Z`, `- Dropped support for…`, `- Deprecated…`, `- Renamed…`, `- Changed behavior of…`, `- Minimum Node/Python version…`. Breaking-change output is tagged `(section)` or `(bullets)` for source transparency.
- `releaseExcerpts` field. When a major or minor bump has no detected breaking changes, the response now includes up to five excerpts (title + first 500 chars of body) from the most recent releases in the range. Gives the LLM raw material when release notes are thin.
- Direct-tag release lookup for the target version. If the `toVersion` release isn't in the recent 500 releases (common for fast-moving projects like Next.js that publish 50+ canaries monthly), the analyzer falls back to `/releases/tags/{tag}` with common tag-format candidates (`v1.2.3`, `1.2.3`, `{repo}-1.2.3`).
- Claude Code install section in README covering `claude mcp add` scopes and the `--env` flag placement.

### Fixed

- GitHub repo URL extraction for packages whose repo names contain dots or dashes (e.g. `vercel/next.js`, `nodejs/node`, `lodash-es`). Previously the regex stopped at the first dot and emitted `vercel/next` instead of `vercel/next.js`.

### Changed

- Package description updated to match the tagline "translates a lockfile diff into a human-readable upgrade plan."
- README documents least-privilege token scope (fine-grained, public repo read only), rotation guidance, and an explicit warning against pasting tokens into AI chats.

### Security

- Recommends `gh` CLI over plaintext config tokens where possible.
- Clarifies the server never writes the token to stdout/stderr or the response payload.

## [0.0.1] - 2026-04-22

### Added

- Initial release.
- `analyze_package_change` tool: single package upgrade analysis (npm, PyPI).
- `analyze_packages_bulk` tool: parallel analysis of up to 50 package changes, ranked by recommendation level.
- Semver classification, GitHub release-notes scraping, OSV.dev CVE deltas, migration-link extraction, recommendation engine.
- LRU cache (500 entries, 1h TTL) on all outbound fetchers.
- `p-limit(8)` concurrency cap on bulk analysis.
- `evals.md` with 15 routing prompts for tool-description verification.

[Unreleased]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/releases/tag/v0.0.1
