# Stage 4 verification evidence (Verifier)

**Verdict: ACCEPT, bound to revision `cc1d710726857c36ef4cc0de22bb97a7046f5fe2`**
(git tree of `stage-4/` `f07693eab95d656c689e05cc90ca9f79b4cebdcc`; candidate content digest
`176a2d44c47dc0de34ee50ebb96762ee082ef169f939096ea31f966a63d37694`, the same before and after the run).
`stage-1/`, `stage-2/` and `stage-3/` are unchanged since 29baf05 / ef962af / 39de1bf.

**Mutation was a 100-mutant seeded sample** (`--max 100 --seed 1`), as the owner directs. Every other gate step ran in full.

| Path | What it is |
|---|---|
| `run-20261005T164036Z-9d2396/` | release-gate run (`commit/verify.ts`, schema v2). Manifest sha256 `bec2f362a7569a72c622f51213d3017f769735a9f907ee66bfcec448999204f7`. Audit passes. |
| `official-harness-s4-verifier-1/` | standalone official isolated run on a clean clone at cc1d710 |

## Results

| Step | Result |
|---|---|
| clean-build, container | `--no-cache` build of stage-4 alone. Offline (`--network none`, 2 vCPU / 2 GiB): healthy, outbound fails, 8080 default. Contract / auth / UI / ledger against capped containers; §2 limits met. |
| official-isolated | judged from `report.json`: suites 1–4 **147/147, 35/35, 6/6, 5/5**, state `completed`. No overshoot suite exists above stage 4, and the judge does not require one. |
| refund-contract | 5/5. **Refunds:** shape (`refund_of`, nulls, note/visibility copied); replay; reuse; 403 sender/third party; 404; 7 invalid amounts; missing amount; key; token; exact remaining amount, then +1 → `refund_exceeds_payment`; refund of a refund → `invalid_refund_target`; refund payments immutable; feed visibility; statement entry. **Limits:** `available` (held money excluded → `insufficient_funds`); corrected amount; correction below refunded → `refund_exceeds_payment`; corrected-to-0 refund; request payment refund (request stays paid); capture refund (authorization stays captured, hold not restored, capture immutable); settlement member refund (not a member). **Batches:** 401/403/400; 0, 33, duplicate, non-array, non-object items; item validation; future effective time; item order (stale before unknown and vice versa); `incomplete_settlement`; differing member instants; Z vs +00:00 spelling accepted; revisions in input order with shared `recorded_at` and `correction_batch_id`; combined money; replay 200; settlement retry returns the original body; single member correction still immutable; combined affordability; `historical_overdraft` with nothing changed; key reusable; snapshot before a batch unchanged. |
| upgrade | stage-1/2 → 4: 58/58. stage-3 → 4: 19/19 — corrections, snapshot, correction replay and settlement membership kept (complete batch passes, incomplete → 422), refund limit = imported corrected amount. Concurrency: 5 rounds × 20 racing single and batch corrections on one expected revision → exactly one wins each time. |
| regression | contract 49/49, auth 14/14, ledger 12/12, extra, survivors, import-semantic, UI 16/16, shipped stage 1. Shape additions per stage 4: `refund_of`, `correction_batch_id`. |
| reference ×8 | ledger (3 seeds × 1,000), holds (3 × 1,000), stage-1 (2 × 1,000): all agree |
| adversarial | ledger 20/20, holds 25/25, stage-1 50/50 |
| mutation-sample | **77 killed / 100 = 77.0%**, 0 timeouts. server.js 61/67; app.js 16/33. |

## Survivors (23)

- **server.js 202** (`expires_ts <= at` → `<`): an exact-millisecond expiry boundary, not reliably reachable black-box. A gap in my checks; the candidate code is correct.
- **server.js 1071**: authorization close times as historical boundaries. A gap in my checks; not exercised by the ledger model, which has no holds.
- **server.js 1713, 1719, 1754**: validation of hand-crafted import state. Unspecified.
- **server.js 1867**: Node 204 path. Equivalent.
- **app.js (17)**: UI-script survivors (relative-time wording, message overrides, UI state flags). **Not individually triaged** before the 23:00 stop.

## Verification failures (my checks were wrong; fixed and re-run)

Two expected values in the refund contract were my arithmetic:
- bob's balance after a 300 refund was 3200, not 2800;
- cy only had 400, so a 900 hold was refused and never placed.

The stage-4 judge first required an overshoot suite that cannot exist for the last stage. The stage-1..3 contracts' payment and revision key sets were extended with `refund_of` and `correction_batch_id`, as stage 4 specifies.

## Limitations

- The mutation sample and the hidden suite: as for stages 2–3.
- **The reference models do not include refunds or correction batches.** Those are covered by the contract, upgrade and concurrency checks only. Written under the 23:00 constraint.
- The app.js survivors were not triaged.
