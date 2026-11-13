#!/usr/bin/env bash
# Guards the rules that let services and infra read contracts/ in place, with no copy or sync step.
# See README.md, "Layout rules".
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "check-layout: $*" >&2; exit 1; }
node -e 'const p = require("./contracts/package.json"); process.exit(p.type || p.dependencies ? 1 : 0)' \
  || fail 'contracts/package.json must not declare "type" or dependencies: services and infra compile contracts/generated/ts as CommonJS TypeScript source'
node -e 'process.exit(require("./package.json").workspaces ? 1 : 0)' \
  || fail 'the root package.json must not declare workspaces (see README.md before changing the npm layout)'
for f in tsconfig.json contracts/tsconfig.json package-lock.json; do
  [ ! -e "$f" ] || fail "$f must not exist"
done
if grep -lE '^[[:space:]]*(import|export)[^;]*[[:space:]]from[[:space:]]' contracts/generated/ts/*.ts; then
  fail 'contracts/generated/ts files must not import other modules'
fi
[ -f contracts/generated/swift/UserAPIContractsV1.swift ] \
  || fail 'billboard-app/scripts/syncContracts.sh reads contracts/generated/swift/UserAPIContractsV1.swift; keep that path'
for d in services/contracts services/src/contracts/generated infra/contracts; do
  [ ! -e "$d" ] || fail "$d must not exist: read contracts/ in place"
done
echo "check-layout: ok"
