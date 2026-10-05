#!/usr/bin/env bash
# Kill check for the mutation campaign: every verification layer against one running
# candidate at $1. Exit 0 = the mutant survived every layer; non-zero = killed.
# Layers run cheapest first and stop at the first failing layer (fail-fast), so a kill
# is attributed to the first layer that caught it; a survivor has passed all of them.
# Prints "COMMIT-LAYER <layer>=<pass|fail>" so commit/mutate.ts can attribute kills.
url="$1"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
kickoff="${COMMIT_KICKOFF:-/home/bajrangi/Wins/dark-factory-wearedevs}"
layer() {
  if "${@:2}" >/dev/null 2>&1; then echo "COMMIT-LAYER $1=pass"; else echo "COMMIT-LAYER $1=fail"; exit 1; fi
}
layer contract node "$here/contract.mjs" --base-url "$url" --seed 1337
layer reference node "$repo/commit/campaign.ts" --module "$here/reference.mjs" --base-url "$url" --seed 481927 --operations 400
layer adversarial node "$here/adversarial.mjs" --base-url "$url" --seeds 11 --burst 30
layer semantic-import node "$here/import-semantic-probe.mjs" "$url"
layer extra node "$here/extra.mjs" "$url"
layer survivors node "$here/survivors.mjs" "$url"
layer shipped env -u PYTHONHOME -u PYTHONPATH -C "$kickoff" "$kickoff/.venv/bin/python" -m pytest -p harness.plugin pocketful/test/stage_1 --base-url "$url" -q -x -p no:cacheprovider
exit 0
