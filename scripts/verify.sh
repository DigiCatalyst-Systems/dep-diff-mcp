#!/bin/sh
# The local gate, the same checks as .github/workflows/ci.yml. Run by
# .githooks/pre-push before every push that changes code, so a red run is found
# on the laptop rather than on the pull request.
set -eu
npm audit --omit=dev --audit-level=high
npm run build
npm test
