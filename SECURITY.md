# Security policy

## Reporting a vulnerability

**Use [private vulnerability reporting](https://github.com/DigiCatalyst-Systems/dep-diff-mcp/security/advisories/new).** It keeps the report private, threads the conversation, and drafts the advisory in the same place. If you would rather use email, write to <kaustubh@digicatalyst.ca>.

Please do not open a public issue for a suspected vulnerability.

Expect an acknowledgement within 3 working days. This is a small project, so a fix may take longer than that; you will be told where it stands rather than left waiting.

## What this server touches

Two deployments, with different exposure:

- **The npm package**, run locally over stdio by your MCP client. It reads a `GITHUB_TOKEN` from the environment or from `gh auth token`, and calls the GitHub and [OSV.dev](https://osv.dev) APIs. The token never leaves your machine.
- **The hosted Worker** at `dep-diff.digicatalyst.ca`, which authenticates to GitHub with its own token. It is stateless and keeps no logs of queries — see [PRIVACY.md](PRIVACY.md). A `?githubToken=` may be supplied on the URL, in which case it is used for that request and not retained.

In scope:

- Anything that leaks a `GITHUB_TOKEN` — into stdout, stderr, a tool response, an error message, or the cache.
- A package name or version that escapes into a request URL, a shell, or a file path.
- Cache poisoning: making one caller's request return another's data, or pinning a wrong result.
- **Reporting a package as safe when the fetched data says otherwise.** Under-reporting risk is the failure this project exists to prevent, so it is treated as a security issue rather than a bug.

Out of scope:

- Vulnerabilities in the packages this server *reports on*. Those belong to their own maintainers.
- Missing advisories caused by upstream data. If OSV or a release note has no record, neither will the analysis.

## Supply chain

Releases are published to npm from a tag, through a GitHub Actions workflow using **OIDC trusted publishing** — there is no npm token to steal, and the trusted publisher is pinned to a specific repository, workflow file, and deployment environment that requires a human approval. Every published version carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) you can verify with `npm audit signatures`.

Release tags `v*.*.*` cannot be moved or deleted; the ruleset enforcing this has no bypass actors, including for administrators. Workflow actions are pinned to commit SHAs.
