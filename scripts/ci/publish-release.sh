#!/usr/bin/env bash
# publish-release.sh <out-dir>: uploads a build-release.sh output. Zips first, manifest last, so a manifest in
# S3 means every zip it names is there. Needs credentials that can write the artifacts bucket.
set -euo pipefail
out="${1:?usage: scripts/ci/publish-release.sh <out-dir>}"
manifest="$out/manifest.json"
release_id="$(jq -r .releaseId "$manifest")"
version="$(cat "$out/version")"
bucket="$(jq -r '.artifacts[0].s3Bucket' "$manifest")"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
jq -r '.artifacts[] | [.logicalName, .s3Key, .releaseS3Key, .sha256] | @tsv' "$manifest" |
while IFS=$'\t' read -r name key release_key sum; do
  zip="$out/zips/${name}-${version}.zip"
  [ "$(sha256 "$zip")" = "$sum" ] || { echo "sha256 mismatch for $zip" >&2; exit 1; }
  aws s3 cp "$zip" "s3://${bucket}/${key}" --only-show-errors
  aws s3 cp "$zip" "s3://${bucket}/${release_key}" --only-show-errors
  # Legacy copies the old services workflow also wrote; remove with CON-08.
  aws s3 cp "$zip" "s3://${bucket}/history/${name}-${version}.zip" --only-show-errors
  aws s3 cp "$zip" "s3://${bucket}/${name}.zip" --only-show-errors
done
aws s3 cp "$manifest" "s3://${bucket}/releases/${release_id}/manifest.json" --only-show-errors
echo "Published ${release_id}: $(jq '.artifacts | length' "$manifest") artifacts to s3://${bucket}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "release_id=${release_id}" >> "$GITHUB_OUTPUT"; fi
