# Tool-routing evals

Run each prompt through Claude/Cursor with dep-diff MCP installed. Verify the listed tool is called.

## Single-package prompts → `analyze_package_change`

1. "What changed between react 18.2.0 and 19.0.0?"
2. "Is bumping lodash from 4.17.20 to 4.17.21 a security fix?"
3. "Should I take the next.js 14 to 15 upgrade?"
4. "Any breaking changes in axios 0.27.0 to 1.7.0?"
5. "What does upgrading requests 2.28.0 to 2.31.0 fix?"
6. "Is pydantic 2.0 a safe upgrade from 1.10?"
7. "Tell me about the vue 3.3 to 3.4 release."
8. "Did webpack 5.89 to 5.94 patch any CVEs?"

## Bulk prompts → `analyze_packages_bulk`

9.  "Here's my Dependabot PR with 12 packages, what's risky?"
10. "I ran npm outdated, tell me which upgrades are safe: react 18->19, lodash 4.17.20->4.17.21, axios 0.27->1.7."
11. "Review this lockfile diff and rank upgrades by risk."
12. "Batch-check these: django 4.2->5.0, requests 2.28->2.31, numpy 1.24->1.26."
13. "Which of these 20 packages in my PR have security fixes?"
14. "Summarize risk for: next.js 14->15, react 18->19, zod 3->4."
15. "I have 30 Dependabot PRs this week, which ones first?"

## Failure modes to watch

- Bulk picked for single-package question → bulk description too broad
- Single picked for list question → single description doesn't cue "for one package only"
- Neither picked → descriptions too vague, strengthen trigger phrases
