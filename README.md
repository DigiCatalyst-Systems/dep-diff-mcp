# dep-diff-mcp

MCP server that translates a lockfile diff into a human-readable upgrade plan.

Point your AI assistant (Cursor, Claude Desktop, Claude Code) at a Dependabot PR, `npm outdated` output, or any pair of package versions, and get back a ranked upgrade plan: semver class, breaking changes pulled from GitHub release notes, CVEs fixed in the range, migration guide links, and a clear recommendation per package.

## What it looks like

Ask your assistant, in plain language:

> Is it safe to bump lodash from 4.17.20 to 4.17.21?

It calls `analyze_package_change` and gets back:

```json
{
  "package": "lodash",
  "ecosystem": "npm",
  "fromVersion": "4.17.20",
  "toVersion": "4.17.21",
  "semverClass": "patch",
  "repoUrl": "https://github.com/lodash/lodash",
  "releaseCount": 0,
  "breakingChanges": [],
  "securityFixes": [
    {
      "id": "GHSA-29mw-wpgm-hmr9",
      "summary": "Regular Expression Denial of Service (ReDoS) in lodash",
      "severity": "MODERATE"
    },
    {
      "id": "GHSA-35jh-r3h4-6jhm",
      "summary": "Command Injection in lodash",
      "severity": "HIGH"
    }
  ],
  "migrationLinks": [],
  "recommendation": "RECOMMENDED: 2 security fix(es) (incl. high/critical).",
  "recommendationLevel": "security"
}
```

A patch bump you would normally merge without looking. It closes a **HIGH-severity command injection**. That is the case this server exists for.

### A whole Dependabot batch

> Here's my Dependabot PR — what's actually risky in it?

`analyze_packages_bulk` takes up to 50 changes at once and ranks them
`security` > `caution` > `review` > `likely-safe` > `safe`:

```json
{
  "totalPackages": 5,
  "bySemverClass": { "major": 1, "minor": 3, "patch": 1 },
  "securityFixesTotal": 7,
  "packagesWithBreakingChanges": 1,
  "packages": [ /* one entry per package, same shape as above */ ]
}
```

Condensing the `recommendation` field of each entry, that batch comes back in this order:

| Package | Change | Class | Verdict |
|---|---|---|---|
| `lodash` | 4.17.20 → 4.17.21 | patch | **RECOMMENDED** — 2 security fixes (incl. high/critical) |
| `axios` | 1.6.0 → 1.7.9 | minor | **RECOMMENDED** — 1 security fix (incl. high/critical) |
| `express` | 4.18.2 → 5.0.0 | major | **RECOMMENDED** — 2 security fixes; 3 breaking changes, [migration guide](https://expressjs.com/en/guide/migrating-5.html) |
| `requests` (PyPI) | 2.31.0 → 2.32.0 | minor | **RECOMMENDED** — 2 security fixes |
| `typescript` | 5.3.3 → 5.4.5 | minor | LIKELY SAFE — minor version, additive changes per semver |

Note the ordering: the `patch` bump outranks the `major` one. Semver tells you how much
changed; it does not tell you what is urgent.

Every response above is real output from the hosted instance, trimmed only where marked.

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

### Hosted remote (no install)

A hosted instance runs at `https://dep-diff.digicatalyst.ca/mcp` over streamable HTTP, so you can skip the npm package entirely:

```bash
claude mcp add -s user -t http dep-diff https://dep-diff.digicatalyst.ca/mcp
```

Or in a client config:

```json
{
  "mcpServers": {
    "dep-diff": {
      "type": "http",
      "url": "https://dep-diff.digicatalyst.ca/mcp"
    }
  }
}
```

The hosted instance authenticates to GitHub with its own token, so release-note lookups work at full rate limits without you configuring anything. Pass `?githubToken=ghp_xxx` on the URL only if you would rather requests counted against your own GitHub quota. It is stateless and keeps no logs of your queries — see [PRIVACY.md](PRIVACY.md). Run the npm package locally instead if you would rather your token never leave your machine.

The same instance is also listed on [Smithery](https://smithery.ai/servers/digicatalyst-systems/dep-diff-mcp), which proxies to it through their gateway.

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

Both tools return this twice: as the JSON text block shown above, and as MCP
[structured content](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)
validated against a declared `outputSchema`. A client that supports structured output can read
`recommendationLevel` or `securityFixes[]` straight off the response instead of re-parsing the text.
Clients that don't are unaffected — the text block is unchanged.

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
