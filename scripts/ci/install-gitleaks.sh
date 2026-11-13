#!/usr/bin/env bash
# install-gitleaks.sh <dir>: puts the pinned gitleaks release into <dir>, after checking the archive's SHA-256 against
# the value below. Linux x64 only: the GitHub-hosted ubuntu runner of the commit-safety check in pr.yml. To update,
# change both values together, taking the SHA-256 from the release's own checksums file.
set -euo pipefail

GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

dir="${1:?usage: scripts/ci/install-gitleaks.sh <dir>}"
mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/gitleaks.tar.gz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  $tmp/gitleaks.tar.gz" | sha256sum -c --quiet -
tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$dir/gitleaks"
"$dir/gitleaks" version
