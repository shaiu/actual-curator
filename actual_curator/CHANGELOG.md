# Changelog

## 0.1.0

First release.

- Every 15 minutes: apply your rules, classify what no rule covers, write category, tags and
  `#auto`, or `#review` when unsure.
- Your answers to `#review` rows become rules. Repeated confident answers for a payee become rules
  too, except for payment apps and standing orders.
- `reviewPayees` (PAYBOX, BIT in the example vocabulary) always go to `#review` until a rule covers
  the recipient.
- Starts in dry run. HTTP API on port 5007 for assistants and scripts.
