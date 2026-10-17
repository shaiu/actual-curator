# Jev spike — rollout gate 1

**Date:** 2026-10-16 · **Script:** `scripts/spike-jev.ts` (throwaway) · **Model:** `typesafe/jev-1.14` via OpenRouter Decisions API

## Setup

- Source: the author's YNAB export, rows since 2025-10-01, on-budget, non-transfer, categorized.
- Pool 1,886 rows. 147 more excluded because their category is hidden, internal or a credit-card payment
  category (not a valid target in production).
- Sample 300, seed 1: 90 rows (30%) from the generic payees in `config/curator.example.yaml`, 210 from the rest.
- State per row exactly as the curator will send it: payee, memo, signed amount as text, account, weekday,
  month, the payee's last three categories before that date. Category question only (no tag questions).
- 70 categories offered (non-hidden expense categories plus income). Hints from the example config.
- 0 errors in 300 calls. Cost **$0.048** (≈ $0.00016 per call). Latency p50 354 ms, p95 465 ms.

"Would reach classifier" = rows whose payee is **not** covered by a bootstrap rule (≥2 rows, ≥90% one
category, 24 months, not generic). In production only these rows get the category question; the rest are
categorized by Actual's rules and get tag questions only.

## Result at the spec threshold (0.80)

| Slice | Rows | Agreement | In ≥0.80 bucket | Agreement in bucket |
|---|---|---|---|---|
| all sampled | 300 | 68.0% | 59.3% (178) | 86.0% |
| generic payees | 90 | 46.7% | 41.1% (37) | 70.3% |
| non-generic | 210 | 77.1% | 67.1% (141) | 90.1% |
| would reach classifier | 166 | 53.6% | 47.6% (79) | 72.2% |

**Gate (≥85% agreement in bucket AND ≥60% of rows in bucket):**

- All sampled rows: agreement passes (86.0%), share misses by 0.7 points (59.3%). **Fail, narrowly.**
- Rows that would actually reach the classifier: 72.2% / 47.6%. **Clear fail.**

## Calibration

| Confidence band | Rows | Agreement |
|---|---|---|
| below 0.50 | 54 | 35.2% |
| 0.50–0.60 | 22 | 45.5% |
| 0.60–0.70 | 20 | 30.0% |
| 0.70–0.80 | 26 | 61.5% |
| 0.80–0.90 | 49 | 77.6% |
| 0.90–0.95 | 24 | 58.3% |
| 0.95–1.00 | 105 | 96.2% |

Confidence is only trustworthy at ≥0.95. The 0.80–0.95 band is no better than a coin flip weighted 2:1.

## Threshold sweep

| Threshold | All: share / agreement | Would reach classifier: share / agreement | Generic: share / agreement |
|---|---|---|---|
| 0.80 | 59% / 86% | 47% / 72% | 41% / 70% |
| 0.85 | 51% / 90% | 41% / 80% | 34% / 81% |
| 0.90 | 43% / 89% | 33% / 76% | 31% / 79% |
| 0.95 | 35% / 96% | 24% / 90% | 24% / 95% |
| 0.98 | 28% / 95% | 19% / 88% | 18% / 94% |

The spec's fallback "raise the threshold until the bucket is ≥90% right" lands at **0.95**: on the rows that
matter, Jev would then file about one in four and send three in four to `#review`.

## Where it goes wrong (96 wrong rows)

The most common confusions were between neighbouring categories (a restaurant filed as a café, a
supermarket as dining out) and P2P transfers guessed as "presents". Per-category counts are left out:
the category names are the author's own.

Patterns:

- **P2P transfers (PAYBOX/BIT to a person's name)** carry no meaning in the memo; Jev guesses "Presents" with
  0.94 confidence. Only the human knows who the person is. These should go to `#review` regardless of
  confidence, or get per-recipient rules after the first answer (now the `reviewPayees` setting).
- **Label noise in the ground truth**: two categories for the same kind of purchase, cafés filed both as
  coffee and as dining out. Some "wrong" answers are defensible; the human's own labels are inconsistent.
- **Personal categories** with an opaque name and no hint are guessed poorly. A one-line `categoryHints`
  entry is the fix.

25 rows were wrong at ≥0.80 confidence (row-level detail with payees and memos kept out of the repo).

## Haiku fallback on the same 300 rows

Same seed, same rows, same state. `anthropic/claude-haiku-5-5` through OpenRouter's OpenAI-compatible endpoint
with a strict JSON schema (`--provider openai-compatible`). Its confidence is self-reported. 0 errors.
Cost **$0.200** (≈ $0.00067 per call, about 4× Jev). Latency p50 2,153 ms, p95 3,098 ms (about 6× Jev).

| Slice | Rows | Agreement | In ≥0.80 bucket | Agreement in bucket |
|---|---|---|---|---|
| all sampled | 300 | 71.3% | 36.3% (109) | 93.6% |
| generic payees | 90 | 51.1% | 16.7% (15) | 93.3% |
| non-generic | 210 | 80.0% | 44.8% (94) | 93.6% |
| would reach classifier | 166 | 58.4% | 24.1% (40) | 85.0% |

Haiku picks the right category a little more often than Jev, and it is underconfident: its 0.50–0.60 band is
87% right.

## Side by side, threshold sweep

| Threshold | Jev, all | Haiku, all | Jev, would reach classifier | Haiku, would reach classifier |
|---|---|---|---|---|
| 0.50 | 82% / 75% | 68% / **87%** | 73% / 61% | 51% / 75% |
| 0.60 | 75% / 78% | 55% / 87% | 64% / 61% | 38% / 71% |
| 0.70 | 68% / 83% | 42% / 90% | 55% / 67% | 30% / 78% |
| 0.80 | 59% / 86% | 36% / 94% | 48% / 72% | 24% / 85% |
| 0.85 | 52% / 90% | 31% / 93% | 42% / 80% | 19% / 81% |
| 0.90 | 43% / 89% | 25% / 92% | 33% / 76% | 14% / 79% |
| 0.95 | 35% / 96% | 8% / 96% | 25% / **90%** | 4% / 86% |

Cells are share in bucket / agreement in bucket.

- On all sampled rows, Haiku at 0.50 passes the spec's gate (87% / 68%). Jev passes at no threshold.
- On the rows that would reach the classifier, neither passes at any threshold. Only Jev reaches the spec's
  fallback bar (bucket ≥90% right): at 0.95 it files a quarter of those rows. Haiku never reaches 90% there.
- Combining the two (write only when both pick the same category) does not help: 76–78% right on the rows
  that would reach the classifier.

The limit is the rows, not the model: the rows without a rule are transfers to people and payees the
household itself labels inconsistently.

## Decision

**2026-10-16, the author: `openrouter-jev` stays the default provider, category threshold raised to 0.95**
(`CONFIDENCE_THRESHOLD` default). Reasons: it is the only model that reaches the spec's fallback bar (≥90%
right) on rows that would reach the classifier; it costs a quarter of Haiku and answers about 6× faster; its
per-category probabilities give the review loop real top-3 candidates. Cost accepted: about three in four
novel-payee rows go to `#review` until answered, and each answer becomes a rule. The 90% rests on 41 rows;
the dry-run decision log (rollout step 2) is the check. Haiku stays available as `anthropic` /
`openai-compatible`.
