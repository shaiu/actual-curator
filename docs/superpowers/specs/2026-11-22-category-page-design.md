# Category drill-down page — design (approved by Shai, 2026-11-22)

## Why

The /budget page shows each line's spent, budgeted and left, but not how
"spent" was reached. Shai and Inbal doubt *what went out*, not why a line got
its budget. A per-category page with its own URL also lets the advisor send a
link for one line in WhatsApp, where long lists are hard to read.

## Approaches

- A. `<details>` under each line on /budget: one tap, but loads every
  transaction up front and gives a line no address of its own.
- **B. A page per category (chosen):** linkable from WhatsApp, keeps /budget
  light, room for month arrows and a summary. Costs one page load per tap.

## Design

Route: `GET /budget/category?month=YYYY-MM&id=<category id>&lang=he|en`.
Same Cloudflare Access verification, CSP (no JavaScript), styles and RTL
handling as /budget.

- Header: category name and month; a back link to `/budget?month=…`.
- Numbers: the line's spent, budgeted and left from `/v1/budget/status` for
  that month, so they match /budget. For a category in `unplanned` or
  `excluded`, or not in the plan at all, only spent.
- Summary: "N transactions, largest: <payee> ₪X".
- List from `/transactions?category=<id>&from=<month start>&to=<month end>`,
  newest first: date, payee, amount, account name; memo small under the row;
  an inflow (refund) shown as a green "+".
- Month arrows: same category, previous / next month (next hidden past the
  current month, as on /budget).
- An id that is not a known category, or a malformed month: a plain
  "not found" page (404), never another category's data.

On /budget every line name links to its category page: daily, fixed,
"Not in the plan" and "Left out by decision".

Advisor (ausie, separate PR, after the add-on runs 0.4.0): when a message is
about one line, add that line's link. WhatsApp keeps its one or two numbers.

Release: curator 0.4.0 via docs/releasing.md (tag before merge).

## Not in scope

Funding history per line, editing from the page, search.

## Builder's calls

- Newest first (reads like a bank statement); the largest is in the summary.
- Category label from `/categories`, the same source as other labels.
- The transactions limit is 1000; a month for one category is far below it.
