# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Follow migration links and extract headings from linked upgrade guides.
- Ecosystem expansion: Cargo, go.mod, Maven.
- Lockfile-diff parser tool.

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

[Unreleased]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/releases/tag/v0.0.1
