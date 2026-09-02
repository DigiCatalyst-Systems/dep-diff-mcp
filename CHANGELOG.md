# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Follow migration links and extract headings from linked upgrade guides.
- Ecosystem expansion: Cargo, go.mod, Maven.
- Lockfile-diff parser tool.
- Re-enable Analytics Engine (or pick an alternative) once on a Workers Paid plan.

## [0.2.3] - 2026-09-02

### Fixed

- A failed GitHub release fetch is no longer cached as "this package has no releases". The paged walk did `if (!res.ok) break`, so a rate-limited page returned whatever had been collected so far — usually nothing — and the LRU stored that empty array for its full one-hour TTL. Observed on the hosted Worker: `express` `4.18.2 -> 5.0.0` returned 1 release and 1 breaking change where identical code returned 12 and 3 locally, stable across repeated calls. The walk is now `collectReleasePages()` and throws `ReleaseFetchError` on a failed page; since the cache only stores resolved values, nothing is persisted and the next request retries. A later-page failure throws as well, rather than returning a partial list as if it were complete.

### Added

- The Worker falls back to a `GITHUB_TOKEN` secret when a request carries no token of its own. The fetch handler was declared `async fetch(request: Request)` and never received `env`, so `wrangler secret put GITHUB_TOKEN` would previously have had no effect — the secret sat in an `env` that no code path read. A caller passing `?githubToken=` still takes precedence and spends their own budget. Without either token the Worker runs on GitHub's 60 requests/hour anonymous limit, keyed to a Cloudflare egress IP shared with other tenants, and a single package analysis costs roughly 2-7 GitHub calls.

### Known limitations

- The response cache is declared at module scope and is therefore per-isolate. Cloudflare recycles Workers isolates frequently, so the one-hour TTL rarely applies on the hosted instance and most requests start cold. Cross-isolate caching (Workers KV or the Cache API) is the structural fix and is not in this release.
- GitHub fetch failures are still swallowed upstream by `.catch(() => [])`, so a degraded response reports zero breaking changes without signalling that release data was unavailable. A token makes this rare, not visible.

## [0.2.2] - 2026-09-01

### Fixed

- Prerelease tags are no longer reported as breaking changes for stable-to-stable upgrades. `semver.coerce()` drops the prerelease component, so `5.0.0-alpha.3` compared equal to `5.0.0` and fell inside a `4.18.2 -> 5.0.0` range — every alpha and beta between the two stable versions leaked into the analysis. The range filter now coerces with `includePrerelease` and excludes prerelease tags when both endpoints are stable. Prereleases are still included when either endpoint is itself one, so `5.0.0-alpha.1 -> 5.0.0` is unaffected. For `express` `4.18.2 -> 5.0.0` this cuts the releases considered from 23 to 12.
- Release-note lines about CI, tests, docs, and tooling are no longer reported as breaking changes. Entries such as `Replace Appveyor windows testing with GHA` and `remove minor version pinning from ci` matched the extractor's verbs (`remove`, `replace`, `deprecated`) without being API changes. Bullets that carry no substance after their keyword — `- remove:`, a bare `- Deprecated` — are dropped as well. Combined with the prerelease fix, `express` `4.18.2 -> 5.0.0` now reports 3 breaking changes instead of 11, all of them genuine.
- An empty `## Breaking Changes` heading no longer emits an entry with no text (`"v0.32.0 (section): "`, seen on `axios` `0.27.2 -> 1.0.0`). The section regex ran past the following heading whenever a blank line preceded it, capturing the next section instead of stopping. The lookahead is tightened and empty excerpts are skipped.

### Security

- Cleared all 13 npm audit advisories (8 high, 3 moderate, 2 low). Seven were in the production tree, every one transitive through `@modelcontextprotocol/sdk`: `hono`, `fast-uri`, `ip-address`, `qs`, `express-rate-limit`, `@hono/node-server`, `body-parser`. None were reachable from this server, which imports only the stdio and `webStandardStreamableHttp` transports, but they installed on every consumer's machine. Most cleared by refreshing stale lockfile resolutions — the caret ranges already permitted patched versions. `@modelcontextprotocol/sdk` 1.29.0 -> 1.30.0 and `tsx` 4.21 -> 4.23.13 needed explicit bumps; `@cloudflare/workers-types` ^4 -> ^5 and `wrangler` 4.84 -> 4.127 moved together to resolve a dev-only peer conflict that was blocking `npm audit fix`. `npm audit` now reports 0 vulnerabilities including the dev tree.

### Added

- README now opens with a "What it looks like" section showing real, unedited tool output — a `lodash` security patch and a five-package Dependabot batch. Every code block in the README was previously configuration, so nothing showed what the tool actually produced without installing it first.
- CI gates on `npm audit --omit=dev --audit-level=high`, with a second informational pass over the full tree that does not block. Scoping the gate to production dependencies keeps dev-tooling advisories from failing unrelated PRs while still catching anything that reaches a consumer.
- Dependabot configuration for npm and github-actions, weekly, with dev dependencies grouped into a single PR so runtime bumps stay individually reviewable.

## [0.2.1] - 2026-08-24

### Added

- Hosted remote endpoint at `https://dep-diff.digicatalyst.ca/mcp`, published in the MCP registry as a `streamable-http` remote. The Worker was previously reachable only on an unadvertised `workers.dev` hostname, so no client had any way to discover it.

### Fixed

- `GET` with `Accept: text/event-stream` now returns `405` instead of holding a stream open. The Worker builds a fresh server and transport per request, so no session survives to push notifications down that stream — it could never deliver anything, and the connection stayed open regardless.

## [0.2.0] - 2026-08-24

### Fixed

- The Worker now serves the MCP transport at `/`, not just `/mcp`. Clients routinely POST JSON-RPC to the base URL; the root handler previously answered every method with the static discovery descriptor and HTTP 200, so those requests failed silently on the client and surfaced no server-side error. Only a plain `GET`/`HEAD` on `/` returns the descriptor now — `POST`, `DELETE`, and SSE negotiation are all routed to the transport. `/health`, `/.well-known/mcp/server-card.json`, `/mcp`, and 404 behaviour are unchanged.

### Changed

- Version bumped to 0.2.0 across `package.json`, `server.json`, and both server definitions. 0.1.10 was published to npm and the MCP registry and then unpublished; the registry entry was left pointing at a version that no longer existed, so that entry has been marked deleted and the line resumes at 0.2.0.

## [0.1.9] - 2026-04-23

### Removed

- Reverted the Cloudflare Analytics Engine binding and emission code introduced in 0.1.8. Analytics Engine requires a Cloudflare Workers Paid plan; the deploy failed on our free-plan account. PRIVACY.md updated to say no telemetry is currently collected. Plan: revisit once the account is upgraded.

## [0.1.8] - 2026-04-23 [YANKED]

**0.1.8 shipped to npm but the Worker deploy failed; the Analytics Engine code was never active on the hosted endpoint. 0.1.9 reverts it.**

## [0.1.7] - 2026-04-23

### Added

- Tool annotations on both tools (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) — lets clients + catalogs like Smithery reason about tool safety without invoking them.
- Two prompts registered on the server:
  - `review_dependabot_pr`: takes an ecosystem + line-separated list of `name from -> to` changes, returns a user message that drives the model to call `analyze_packages_bulk`.
  - `explain_package_upgrade`: takes `{ecosystem, name, fromVersion, toVersion}`, returns a user message for a single-package analysis.
- `/.well-known/mcp/server-card.json` now advertises the annotations and prompts so Smithery's quality scorer picks them up without live scanning.

### Changed

- Smithery quality score: 68 → target ~97 with annotations (7pt) and prompts (5pt) covered by this release. Description, Homepage, and Icon (27pt) still need to be set in the Smithery dashboard UI.

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

[Unreleased]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/releases/tag/v0.0.1
