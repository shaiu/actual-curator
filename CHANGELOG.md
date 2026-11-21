# Changelog

## 0.3.0 — a budget page

- `GET /budget` (`src/http/budget-page.ts`): a read-only page over `GET /v1/budget/status` and
  `GET /v1/budget/propose`, called in-process through the API app with its own bearer token, so it
  shows exactly the JSON the advisor reads and holds no budget math of its own. Same Access check,
  headers (no-store, `default-src 'none'`) and language cookie pattern as `/money`. A past month shows
  status only; a month with no plan says so.
- Layout from reference apps: one "left for day-to-day" number with a pace line (Monarch flex,
  PocketGuard leftover), a bar per variable line with today's expected mark (Copilot), and
  over/left per line coloured by `status` (YNAB).

## 0.2.1 — plan accounts are checked; overspending cover is not double-counted

- `PUT /v1/budget/plan` and every route that loads the plan answer 409 `stale_plan` when an income
  source's `account` is not an open on-budget account id. The message lists `name=id` for each valid
  account. Measured 2026-11-21: a plan saved with `account: "Hapoalim"` matched no deposit and
  `landed` stayed `[]` with no error.
- `propose` and `apply` keep two budgets. Every shekel comes out of this month's To budget. Only the
  part that does not cover this month's overspending comes out of `min(later To budget)`, because a
  later month already lost that overspending. New fields: `proposal.coversOverspend` and
  `lines[].covers`; `proposed - coversOverspend <= available`. A carryover category is not covered
  this way: its overspend never left next month's To budget. Measured 2026-11-21: a 29,275.30
  proposal left 20,865.22 free after apply, because about 20,865 of it covered spent lines.
- `CategoryMonth.carryover` and `accounts()[].closed` are read from Actual.

## 0.2.0 — a monthly envelope budget

- Seven routes under `/v1/budget` run the monthly envelope budget: `GET`/`PUT /plan`, `GET /propose`,
  `POST /apply`, `POST /move`, `GET /status` and `POST /status/ack`. Every number is computed in
  code (what to fund, what is on pace, what to move); an assistant only quotes and applies them.
- Requests take shekels (at most 2 decimals). Responses give `{amount, formatted}`, with `amount`
  in agorot. The plan itself is kept in shekels.
- The plan lives in `$DATA_DIR/budget/` (`plan.json`, `plan-history.jsonl`, `writes.jsonl`,
  `state.json`, each written atomically). It is not seeded: with no plan saved, propose and status
  answer 409 `no_plan`. A plan category that is missing or hidden in Actual is 409 `stale_plan`.
- Past months are read-only (400 `past_month`). Excluded categories never appear in a proposal, in
  status or in suggested moves. A protected category is never a move source, and neither is a
  category that is not in the plan.
- A proposal never funds more than the lowest To budget of that month and every later month Actual
  has data for, because Actual carries a month's leftover into the next. Apply checks the same
  limit, and a change in any of those months makes the proposal stale (409 `stale_proposal`).
- Status gives pace per category, suggested moves and events: income landed (on-budget accounts,
  and the source's account if the plan names one), a fixed transfer that did not arrive, a
  category on `watch` or `off`, and rows waiting for review. Events repeat until acked with
  `POST /status/ack`. Carried-over balance is not counted as overspending.
- Propose, apply and move sync with the Actual server first; if that fails they answer 503
  `sync_failed` and write nothing. A write Actual could not confirm is journaled as `unconfirmed`.

## 0.1.6 — a readable money page

- `GET /money`: one phone-sized page, Hebrew (right to left, the default) or English, that says what
  was spent and what came in this month, how that compares with last month at the same day, where
  the money went (categories biggest first, as bars), and the watched categories this month against
  last month. Earlier months are one tap away. Numbers are the reports' numbers: report exclusions
  apply and refunds reduce a category.
- The page is served only behind Cloudflare Access. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; the
  app verifies the signed-in person's Access token itself (signature, audience, issuer, expiry), so
  the LAN port does not open it and service tokens do not count as a person. Without both settings
  the page does not exist.
- `MONEY_WATCH_CATEGORIES`: category labels or ids for the watched list.

## 0.1.5 — nothing is filed into a hidden category

- A row that lands in a hidden category goes to review, uncategorized, instead of being accepted as a
  rule hit. This covers a row Actual filed at import and a row a curator-readable rule would file.
  The classifier is offered the visible categories for it. Before, rules carried over from YNAB
  filed new spending into categories hidden since, where no budget view showed it, and some mobile
  clients' overspending badges skip hidden categories. A row someone puts in a hidden category in
  Actual before the curator's next run is also sent to review.
- When such a row is answered, each rule that sent it to the hidden category (Actual's payee-id
  rules included) is pointed at the answer, so the payee's next row lands right at import.
- `GET /v1/rules` marks each rule with `categoryHidden`. `GET /v1/review` rows carry
  `reviewReason`, the logged reason the row is in review (e.g. `category Needs / Dentist (hidden)
  is hidden`).
- Rows carry `payeeId` internally, the id Actual's own rules match on.

## 0.1.4 — leave categories out of reports

- New option `REPORT_EXCLUDE_CATEGORIES` (app option `report_exclude_categories`): category labels
  or ids, comma-separated. The spend, income and compare reports skip those categories in every
  cut (category, group, tag) and in their totals, and name them in an `excluded` field. Use it for
  one-off money, such as a house purchase, that would swamp a monthly total. `/v1/transactions`
  still finds the rows. A name that matches no category is logged once and ignored.

## 0.1.3 — date ranges honour `to`

- `/v1/transactions` and the spend, income and compare reports ignored the end of a date range:
  Actual's query language kept only `$gte` from `{ date: { $gte, $lte } }`. A range now runs from
  `from` to `to` inclusive. Before, every report ran from `from` to the newest row, so a
  "June to August" total included September onwards, and a page of transactions for January
  started with the newest rows.

## 0.1.2 — reviewSince on /v1/review rows

- Each `/v1/review` row carries `reviewSince`: when it was put in review, from the decision log
  (`null` if the log has no such decision).
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
