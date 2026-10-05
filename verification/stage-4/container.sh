#!/usr/bin/env bash
# Container checks, the way the task says the deliverable runs: built from stage-1/ alone,
# no outbound network, 2 vCPU / 2 GiB. usage: container.sh <out-dir> <image-tag>
set -u
out="$(mkdir -p "$1" && cd "$1" && pwd)"
tag="$2"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
note() { echo "$*"; }
cleanup() { docker rm -f vf4-off vf4-def vf4-cap1 vf4-cap2 >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
# 1. offline start, health within 60 s, outbound blocked
docker run -d --name vf4-off --network none --cpus 2 --memory 2g -e PORT=9000 "$tag" >/dev/null || { note "FAIL: container did not start"; exit 1; }
t0=$(date +%s%N); ok=0
for i in $(seq 1 600); do
  if body=$(docker exec vf4-off wget -q -T 1 -O - http://127.0.0.1:9000/health 2>/dev/null); then ok=1; break; fi
  sleep 0.1
done
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
if [ $ok = 1 ] && [ "$body" = '{"status":"ok"}' ]; then note "offline: healthy after ${ms} ms on --network none ($(docker inspect vf4-off --format '{{.HostConfig.NetworkMode}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}}'))"; else note "FAIL: offline health (${ms} ms, body=$body)"; fail=1; fi
if docker exec vf4-off wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then note "FAIL: outbound network reachable"; fail=1; else note "offline: outbound request from inside the container fails, as required"; fi
# 2. default port 8080 when PORT is empty
docker run -d --name vf4-def --network none -e PORT= "$tag" >/dev/null
sleep 2
if [ "$(docker exec vf4-def wget -q -T 2 -O - http://127.0.0.1:8080/health 2>/dev/null)" = '{"status":"ok"}' ]; then note "default port: 8080 serves with PORT unset/empty"; else note "FAIL: default port 8080"; fail=1; fi
# 3. capped containers with port mappings: contract (incl. cross-process import) and §2 limits
docker run -d --name vf4-cap1 --cpus 2 --memory 2g -e PORT=9000 -p 127.0.0.1:19501:9000 "$tag" >/dev/null
docker run -d --name vf4-cap2 --cpus 2 --memory 2g -e PORT=9000 -p 127.0.0.1:19502:9000 "$tag" >/dev/null
for i in $(seq 1 100); do curl -sf http://127.0.0.1:19501/health >/dev/null && curl -sf http://127.0.0.1:19502/health >/dev/null && break; sleep 0.1; done
node "$here/contract.mjs" --base-url http://127.0.0.1:19501 --second-url http://127.0.0.1:19502 --out "$out/contract-container.json" > "$out/contract-container.log" 2>&1 || { note "FAIL: contract against the container"; fail=1; }
tail -1 "$out/contract-container.log"
node "$here/limits.mjs" http://127.0.0.1:19501 200 > "$out/limits.log" 2>&1 || { note "FAIL: §2 limits"; fail=1; }
cat "$out/limits.log"
node "$here/auth-contract.mjs" --base-url http://127.0.0.1:19501 --out "$out/auth-contract-container.json" > "$out/auth-contract-container.log" 2>&1 || { note "FAIL: auth contract against the container"; fail=1; }
tail -1 "$out/auth-contract-container.log"
env -u PYTHONHOME -u PYTHONPATH "${COMMIT_KICKOFF:-/home/bajrangi/Wins/dark-factory-wearedevs}/.venv/bin/python" "$here/ui_checks.py" http://127.0.0.1:19501 --out "$out/ui-container.json" > "$out/ui-container.log" 2>&1 || { note "FAIL: UI checks against the container"; fail=1; }
tail -1 "$out/ui-container.log"
node "$here/ledger-contract.mjs" --base-url http://127.0.0.1:19501 --out "$out/ledger-contract-container.json" > "$out/ledger-contract-container.log" 2>&1 || { note "FAIL: ledger contract against the container"; fail=1; }
tail -1 "$out/ledger-contract-container.log"
exit $fail
