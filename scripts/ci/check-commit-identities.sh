#!/usr/bin/env bash
# check-commit-identities.sh <revision range>: fails unless every commit in the range (as git rev-list reads it, such
# as base..head, or one commit for everything reachable from it) carries only allowed email addresses: its author,
# its committer, and every address in its message, so trailers such as Co-authored-by and Signed-off-by too.
#
# Allowed:
#   - GitHub noreply addresses (12345+name@users.noreply.github.com, bots' [bot] addresses included): the address
#     contributors commit with (CONTRIBUTING.md, "Licence of contributions");
#   - noreply@github.com: GitHub itself, as the committer of merges and edits made on github.com;
#   - the project identity, contact@billboard-project.com (the project's maintainers and their tooling);
#   - noreply@anthropic.com: the Co-Authored-By trailer of the project's AI coding agent, on the project's own
#     commits (CONTRIBUTING.md, "AI-assisted contributions").
# Each failure names the commit and the field, with the address masked. Exits 1 on any failure, 2 on a usage error.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: scripts/ci/check-commit-identities.sh <revision range>" >&2; exit 2; }
range="$1"

PROJECT_ADDRESS='contact@billboard-project.com'

allowed() {
  local address
  address="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$address" in
    "$PROJECT_ADDRESS" | noreply@github.com | noreply@anthropic.com) return 0 ;;
  esac
  [[ "$address" =~ ^([0-9]+\+)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\[bot\])?@users\.noreply\.github\.com$ ]]
}

# "j***@e***.com": enough to find the commit, without repeating the address in a public log.
mask() {
  local local_part="${1%@*}" domain="${1#*@}"
  printf '%s***@%s***.%s' "${local_part:0:1}" "${domain:0:1}" "${domain##*.}"
}

commits="$(git rev-list "$range")" || { echo "check-commit-identities: cannot read the range $range" >&2; exit 2; }
failed=0
checked=0
for commit in $commits; do
  checked=$((checked + 1))
  short="$(git rev-parse --short "$commit")"
  author="$(git log -1 --format=%ae "$commit")"
  committer="$(git log -1 --format=%ce "$commit")"
  for field in author committer; do
    address="$author"
    [ "$field" = committer ] && address="$committer"
    if [ -z "$address" ] || ! allowed "$address"; then
      echo "$short: $field address not allowed: $(mask "$address")"
      failed=1
    fi
  done
  while IFS= read -r address; do
    [ -n "$address" ] || continue
    if ! allowed "$address"; then
      echo "$short: address in the commit message not allowed: $(mask "$address")"
      failed=1
    fi
  done < <(git log -1 --format=%B "$commit" | grep -oE '[A-Za-z0-9._%+-]+(\[bot\])?@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' || true)
done

if [ "$failed" -ne 0 ]; then
  echo "check-commit-identities: FAILED. Commit with your GitHub noreply address (GitHub Settings > Emails), then rewrite the commits above, for example with git rebase and git commit --amend --reset-author." >&2
  exit 1
fi
echo "check-commit-identities: ok ($checked commits)"
