#!/usr/bin/env bash
# Prints Markdown for a PR description showing every docs/screenshots/ image
# the branch changes, before and after. The images are already committed, so
# the links point at the base and head commits (PR refs keep them reachable
# after merge); nothing is uploaded. Push the branch first.
#
#   make screenshots && git commit … && git push
#   scripts/pr-shots.sh [base]          (base defaults to origin/main)
set -euo pipefail

base_ref="${1:-origin/main}"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
head="$(git rev-parse HEAD)"
base="$(git merge-base "$base_ref" HEAD)"
if ! git branch -r --contains "$head" | grep -q .; then
  echo "HEAD $head is not pushed yet: push the branch first" >&2
  exit 1
fi
raw() { printf 'https://raw.githubusercontent.com/%s/%s/%s' "$repo" "$1" "$2"; }

changed="$(git diff --name-only --diff-filter=AM "$base" "$head" -- 'docs/screenshots/*.png')"
if [ -z "$changed" ]; then
  echo "No visible change (docs/screenshots/ is unchanged)."
  exit 0
fi
echo "| Screen | Before | After |"
echo "|---|---|---|"
while read -r f; do
  name="$(basename "$f" .png)"
  if git cat-file -e "$base:$f" 2>/dev/null; then
    before="<img src=\"$(raw "$base" "$f")\" width=\"240\">"
  else
    before="(new)"
  fi
  echo "| $name | $before | <img src=\"$(raw "$head" "$f")\" width=\"240\"> |"
done <<< "$changed"
