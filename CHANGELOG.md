# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Broader breaking-change detection in release notes (match "removed", "no longer", "now requires", "incompatible", not only explicit `## Breaking Changes` headers).
- Follow migration links and extract headings from upgrade guides.
- Include release body excerpts as fallback context when no Breaking section exists.

## [0.0.2] - 2026-04-22

### Added

- `GITHUB_TOKEN` resolution now falls back to `gh auth token` when the env var is unset. Users with the GitHub CLI authenticated get full API rate limits without putting a plaintext token in their MCP config.
- Stderr log line indicates which token source was used (env, `gh`, or anonymous).

### Changed

- README now documents least-privilege token scope (fine-grained, public repo read only), rotation guidance, and an explicit warning against pasting tokens into AI chats.
- Package description updated to match the tagline "translates a lockfile diff into a human-readable upgrade plan."

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

[Unreleased]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/DigiCatalyst-Systems/dep-diff-mcp/releases/tag/v0.0.1
