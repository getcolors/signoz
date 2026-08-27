#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-signoz-green/green"
grep -q 'io.github.getcolors.signoz.workflow/workflow' "$launcher"
grep -q 'def \^:private signoz-sha' "$launcher"
[[ -L "$root/green/green" ]] && [[ $(readlink "$root/green/green") == ../skills/package-signoz-green/green ]]
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "$launcher" "$tmp/green"; chmod +x "$tmp/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/colors.yml"
(cd "$tmp" && SIGNOZ_LIB_ROOT="$root" ./green build >/dev/null)
[[ -f "$tmp/.colors/signoz-fixture/signoz-infrastructure/main.tf" ]]
[[ -f "$tmp/.colors/signoz-fixture/signoz-ansible/compose.yml" ]]
# The launcher walks up for colors.yml, so any subdirectory works.
mkdir -p "$tmp/nested/path"
(cd "$tmp/nested/path" && SIGNOZ_LIB_ROOT="$root" ../../green build >/dev/null)
# The profile guard is the whole reason COLORS_PAR_PROFILE is refused: an
# overlay would point one deployment at another's state.
out=$(cd "$tmp" && SIGNOZ_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out"
[[ ! -d "$tmp/.colors/wrong" ]]
echo 'launcher: all checks passed'
