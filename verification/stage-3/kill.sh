#!/usr/bin/env bash
# Stage-3 kill check for the (sampled) mutation campaign: every layer against one running
# candidate at $1, cheapest first, stopping at the first failing layer.
url="$1"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
kickoff="${COMMIT_KICKOFF:-/home/bajrangi/Wins/dark-factory-wearedevs}"
py() { env -u PYTHONHOME -u PYTHONPATH "$kickoff/.venv/bin/python" "$@"; }
layer() {
  if "${@:2}" >/dev/null 2>&1; then echo "COMMIT-LAYER $1=pass"; else echo "COMMIT-LAYER $1=fail"; exit 1; fi
}
layer contract node "$here/contract.mjs" --base-url "$url" --seed 1337
layer auth-contract node "$here/auth-contract.mjs" --base-url "$url"
layer ledger-contract node "$here/ledger-contract.mjs" --base-url "$url"
layer reference-ledger node "$repo/commit/campaign.ts" --module "$here/reference-ledger.mjs" --base-url "$url" --seed 481927 --operations 300
layer adversarial-ledger node "$here/adversarial-ledger.mjs" --base-url "$url" --seeds 11 --burst 20
layer reference-holds node "$repo/commit/campaign.ts" --module "$here/reference-holds.mjs" --base-url "$url" --seed 481927 --operations 400
layer ui env -u PYTHONHOME -u PYTHONPATH VF_FAIL_FAST=1 VF_UI_TIMEOUT_MS=4000 "$kickoff/.venv/bin/python" "$here/ui_checks.py" "$url"
layer reference node "$repo/commit/campaign.ts" --module "$here/reference.mjs" --base-url "$url" --seed 481927 --operations 300
layer adversarial-holds node "$here/adversarial-holds.mjs" --base-url "$url" --seeds 11 --burst 30
layer adversarial node "$here/adversarial.mjs" --base-url "$url" --seeds 11 --burst 30
layer survivors node "$here/survivors.mjs" "$url"
layer extra node "$here/extra.mjs" "$url"
layer semantic-import node "$here/import-semantic-probe.mjs" "$url"
layer shipped-stage-1 env -u PYTHONHOME -u PYTHONPATH -C "$kickoff" "$kickoff/.venv/bin/python" -m pytest -p harness.plugin pocketful/test/stage_1 --base-url "$url" -q -x -p no:cacheprovider
exit 0
