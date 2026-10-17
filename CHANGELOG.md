# Changelog

## Unreleased

- Rule bootstrap: a YNAB payee named after the memo (a standing order shown as its recipient)
  becomes a rule on the generic payee Actual imports it under (`הוראת-קבע`) plus the name in the
  memo. Before, it became a rule on the recipient's name, which never matched.

## 0.1.1

- Home Assistant app: default host port 8507 instead of 5007, which the Traccar app holds. The
  port inside the container stays 5007.

## 0.1.0 — unreleased

First release.

- Curator run every 15 minutes: sync, settle answered `#review` rows into rules, apply the
  curator's own payee rules to backlog rows, classify the rest, write category + tags + `#auto`
  (or `#review`), promote repeated confident answers to rules, sync again.
- `reviewPayees` in the vocabulary: rows from these payees (PAYBOX, BIT in the example) always go
  to `#review` unless a rule already categorized them.
- Classifiers: `openrouter-jev` (default), `anthropic`, `openai-compatible`.
- Decision log (`$DATA_DIR/decisions/YYYY-MM.jsonl`) written before every write.
- HTTP API under `/v1` with bearer auth, documented in `openapi.yaml`.
- Alerts by Telegram and/or Home Assistant persistent notification after an hour of failed runs.
- YNAB rule bootstrap script.
- Docker image (`linux/amd64`, `linux/arm64`) and Home Assistant app (`actual_curator/`).
