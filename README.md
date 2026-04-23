# dep-diff-mcp

MCP server that translates a lockfile diff into a human-readable upgrade plan.

Point your AI assistant (Cursor, Claude Desktop, Claude Code) at a Dependabot PR, `npm outdated` output, or any pair of package versions, and get back a ranked upgrade plan: semver class, breaking changes pulled from GitHub release notes, CVEs fixed in the range, migration guide links, and a clear recommendation per package.

## Install

### Claude Code

One command, user scope (available in every project):

```bash
claude mcp add -s user dep-diff -- npx -y @digicatalyst/dep-diff-mcp
```

Project scope (writes `.mcp.json` at repo root, team-shared):

```bash
claude mcp add -s project dep-diff -- npx -y @digicatalyst/dep-diff-mcp
```

With an explicit token (skip this if you have the `gh` CLI authenticated — see [GitHub token](#github-token-optional-but-recommended) below):

```bash
claude mcp add -s user --env GITHUB_TOKEN=ghp_xxx dep-diff -- npx -y @digicatalyst/dep-diff-mcp
```

Verify:

```bash
claude mcp list
```

Restart the Claude Code session to pick up the server.

### Cursor and Claude Desktop

Add to your MCP client config:

- Cursor: `~/.cursor/mcp.json`
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "dep-diff": {
      "command": "npx",
      "args": ["-y", "@digicatalyst/dep-diff-mcp"]
    }
  }
}
```

Restart your MCP client. Ask something like "what's risky in this Dependabot PR?" and the tools are invoked automatically.

## GitHub token (optional but recommended)

The server hits the GitHub API to read release notes. Without a token you get 60 requests per hour (GitHub's anonymous limit) — enough for occasional single-package queries, not enough for bulk lockfile analysis.

The server resolves a token in this order:

1. `GITHUB_TOKEN` environment variable, if set.
2. `gh auth token` — if the [GitHub CLI](https://cli.github.com) is installed and authenticated, the server uses that token automatically. No config change needed.
3. Anonymous (60 req/hr).

### Recommended: use the `gh` CLI

If you already have `gh` installed (`brew install gh && gh auth login`), stop here — the server picks up your existing auth. No plaintext token anywhere.

### Alternative: environment variable

Create a **fine-grained** token at <https://github.com/settings/tokens>:

- **Token name:** `dep-diff-mcp`
- **Expiration:** 90 days (rotate periodically)
- **Repository access:** `Public Repositories (read-only)` — no private repo access
- **Permissions:** none beyond the default public read — do **not** grant `repo`, `workflow`, `user`, or any write scope

Then reference it in the MCP config:

```json
{
  "mcpServers": {
    "dep-diff": {
      "command": "npx",
      "args": ["-y", "@digicatalyst/dep-diff-mcp"],
      "env": { "GITHUB_TOKEN": "github_pat_xxx" }
    }
  }
}
```

### Security notes

- This config file lives on your disk in plaintext. Keep perms tight (`chmod 600`) and **do not paste the token into AI chats, issues, or shared screens** — transcripts are often retained.
- The token in this config should be least-privilege (public repo read only). Even leaked, it can only read public data you could already read.
- Rotate tokens periodically. Revoke any token that may have been exposed at <https://github.com/settings/tokens>.
- The server never writes the token to stdout/stderr or the response payload.

## Tools

### `analyze_package_change`
Analyze one package upgrade. Inputs: `ecosystem` (`npm` or `pypi`), `name`, `fromVersion`, `toVersion`.

### `analyze_packages_bulk`
Analyze up to 50 package upgrades in parallel. Returns packages ranked by risk (`security` > `caution` > `review` > `likely-safe` > `safe`), plus summary counts.

## What you get back

- **Semver classification** — major / minor / patch / downgrade / unknown
- **Breaking changes** — extracted from GitHub release notes headers
- **Security fixes** — CVEs present at `fromVersion` but resolved at `toVersion` (via OSV.dev)
- **Migration links** — upgrade guide URLs found in release notes
- **Recommendation** — single-line verdict + level

## Supported ecosystems

- npm
- PyPI

## Development

```bash
npm install
npm run build
GITHUB_TOKEN=ghp_xxx npm run inspect   # MCP Inspector
```

## License

MIT
