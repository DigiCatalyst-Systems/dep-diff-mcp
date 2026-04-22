# dep-diff-mcp

MCP server that reads dependency changelogs and tells you what's risky in an upgrade.

Point your AI assistant (Cursor, Claude Desktop, Claude Code) at a Dependabot PR, `npm outdated` output, or any pair of package versions, and get back a ranked risk report: semver class, breaking changes pulled from GitHub release notes, CVEs fixed in the range, migration guide links, and a clear recommendation per package.

## Install

Add to your MCP client config (Cursor: `~/.cursor/mcp.json`, Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dep-diff": {
      "command": "npx",
      "args": ["-y", "@digicatalyst/dep-diff-mcp"],
      "env": { "GITHUB_TOKEN": "ghp_your_token" }
    }
  }
}
```

Create a GitHub token at <https://github.com/settings/tokens> (fine-grained, no scopes needed — public repo read access is the default). Without a token you get 60 GitHub API requests per hour, which runs out on the first bulk call.

Restart your MCP client. Ask something like "what's risky in this Dependabot PR?" and the tools will be invoked automatically.

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
