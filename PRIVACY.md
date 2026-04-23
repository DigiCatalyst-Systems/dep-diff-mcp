# Privacy Policy

**Last updated:** 2026-04-23

## Summary

`dep-diff-mcp` does not collect, store, or transmit any personal data. It is a stateless analysis tool that queries public package-metadata and security APIs on your behalf.

## Data this tool sends to third parties

To answer a request, the server fetches from these public services:

- **npm registry** (`registry.npmjs.org`) — package metadata lookups.
- **PyPI** (`pypi.org`) — package metadata lookups.
- **GitHub REST API** (`api.github.com`) — release notes, tags. Uses your GitHub token if you supply one (via `GITHUB_TOKEN`, the `gh` CLI, or per-request config on the hosted endpoint). Without a token, requests are anonymous and rate-limited.
- **OSV.dev** (`api.osv.dev`) — security advisory lookups (CVE/GHSA) for the exact package and version you asked about.

Only package names and version strings you provide to the tool are sent to those services. No arbitrary content from your codebase, files, or conversations is transmitted.

## Data this tool stores

- **In-memory cache only.** Fetched metadata is kept in an LRU cache (max 500 entries, 1 hour TTL) to reduce duplicate API calls. The cache is flushed when the process or Cloudflare Worker instance terminates. Nothing is written to disk.
- **No logs of user content.** The server emits a single stderr diagnostic indicating whether a GitHub token was resolved (env, `gh` CLI, or anonymous). Query parameters and tool inputs are not logged.

## GitHub token handling

- If you supply a `GITHUB_TOKEN`, it is used in-memory for the duration of the current request or process and is never written to disk, logged, or forwarded to any service other than `api.github.com`.
- The hosted Cloudflare Worker endpoint accepts per-request tokens via query string (`?githubToken=…` or `?config=…`). Cloudflare receives the request URL as part of standard edge logging; do not include a sensitive token on channels where the URL may be retained.
- No operator-side shared GitHub token is set on the hosted Worker. Each caller supplies their own token (or runs anonymously).

## Cloudflare Worker hosting

The hosted endpoint at `https://dep-diff-mcp.digicatalyst-systems.workers.dev` runs on Cloudflare Workers. Cloudflare may apply its own edge-request logging, analytics, and security protections; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/). This project does not add any additional server-side logging.

## Telemetry

The hosted Cloudflare Worker records **aggregate** usage counters via Cloudflare Analytics Engine. For each request to `/mcp` it writes one data point containing:

- the JSON-RPC method name (e.g. `tools/call`, `prompts/get`, `initialize`), and
- the tool or prompt name (e.g. `analyze_package_change`), if present.

It does **not** record: tool arguments, package names queried, GitHub tokens, IP addresses, request bodies, or any user identifier. The operator uses these counts to decide whether continued hosting is worth the effort. If you object to even this aggregate counting, use the stdio install (`npx -y @digicatalyst/dep-diff-mcp`) — the stdio path sends no telemetry of any kind.

The self-hosted stdio binary sends no telemetry.

## Source code

The full source is public at <https://github.com/DigiCatalyst-Systems/dep-diff-mcp>. Verify any of the above by reading the code.

## Contact

For privacy questions, open an issue at <https://github.com/DigiCatalyst-Systems/dep-diff-mcp/issues>.
