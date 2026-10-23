# Changelog

## 0.1.3

- Reports and transaction lists now stop at the end date you ask for. Before, they ran to the
  newest transaction.

## 0.1.2

- `/v1/review` rows now say when they were put in review (`reviewSince`).

## 0.1.1

- The HTTP API's default host port is now 8507. 5007 collided with the Traccar app, which holds
  many ports in the 5000 range, so the app failed to start with "port 5007 is already in use".
  If you changed the port under **Network**, your setting is kept. If you use the default, update
  any assistant or script that called port 5007 on your Home Assistant host.

## 0.1.0

First release.

- Every 15 minutes: apply your rules, classify what no rule covers, write category, tags and
  `#auto`, or `#review` when unsure.
- Your answers to `#review` rows become rules. Repeated confident answers for a payee become rules
  too, except for payment apps and standing orders.
- `reviewPayees` (PAYBOX, BIT in the example vocabulary) always go to `#review` until a rule covers
  the recipient.
- Starts in dry run. HTTP API on port 5007 for assistants and scripts.
