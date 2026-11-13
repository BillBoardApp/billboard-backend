#!/usr/bin/env bash
# build-release.sh <out-dir>: builds every Lambda and writes <out-dir>/zips/*.zip, manifest.json, release-id
# and version for the checked-out commit. Makes no AWS calls.
set -euo pipefail
out="${1:?usage: scripts/ci/build-release.sh <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"; out="$(cd "$out" && pwd)"
rm -rf "$out/zips" "$out/manifest.json"; mkdir -p "$out/zips"
sha="${GITHUB_SHA:-$(git -C "$root" rev-parse HEAD)}"
version="${sha:0:7}"
release_id="services-$(date -u +%Y%m%d)-${version}"
cd "$root/services"
npm run build --silent
node scripts/packageLambdas.cjs --version "$version" --out-dir "$out/zips"
node scripts/generateReleaseManifest.cjs --release-id "$release_id" --bucket billboard-lambda-artifacts \
  --version "$version" --zip-dir "$out/zips" \
  --repository "${GITHUB_REPOSITORY:-BillBoardApp/billboard-backend}" --commit-sha "$sha" \
  --branch "${GITHUB_REF_NAME:-$(git -C "$root" rev-parse --abbrev-ref HEAD)}" --out "$out/manifest.json"
printf '%s\n' "$release_id" > "$out/release-id"
printf '%s\n' "$version" > "$out/version"
