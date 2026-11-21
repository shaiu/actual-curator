# Changelog

## 0.3.4

- `/budget`: the "Not in the plan" note now says what happened: the money was paid this month without
  a budget, so until it is covered this month's free money looks bigger than it is.

## 0.3.3

- `/budget` shows a "Not in the plan" section: categories with spending this month that the plan does
  not track, with what was spent and the balance. Overspending there comes out of next month, so it
  is no longer invisible. Categories left out of the plan on purpose are listed apart, collapsed.

## 0.3.2

- A proposal now covers every overspent planned line back to zero from money that has no job yet,
  even past the line's planned amount. The overspend is already gone; leaving it uncovered only
  moves it into next month.
- A move between lines is suggested only for what unassigned money cannot cover.
- `/budget` explains its top numbers in one line each, and what red and amber mean.

## 0.3.1

- `/budget`: each line is measured against what it held this month, money carried over from earlier
  months included, so a line that spends last month's leftover no longer shows a full bar over ₪0.
  Empty lines are left out. Suggested moves show only when no proposal is giving money, and read
  "Gas ← Phone ₪80" instead of a scrambled sentence. Category names no longer reorder Hebrew text.

## 0.3.0

- New page, `/budget`: the month's budget on one phone-sized page, Hebrew by default, behind the same
  Cloudflare Access sign-in as `/money`. At the top, what is left for day-to-day spending and whether
  you are ahead of or behind today's pace. Then a bar per day-to-day line with a mark for where
  spending should be by today, the fixed bills (paid or still due), the advisor's current proposal
  line by line, and the income that has arrived or is still expected. It only reads; approving a
  proposal still happens in the finance chat.

## 0.2.1

- A budget plan whose income source names an account by its name, or by an account that is off
  budget or closed, is refused with the list of valid account ids. Before, such a source never
  matched any deposit, with no error.
- A proposal no longer counts money that covers this month's overspending against what is free for
  later months, so one approval funds the month fully instead of leaving money unassigned.

## 0.2.0

- New monthly budget: the app can now work out how to fund each category for the month, apply it in
  Actual after you approve, move money between categories, and tell you what is off pace. All the
  numbers come from code, not from the model. There are no new options.

## 0.1.6

- New **/money** page: this month's spending in plain words, in Hebrew or English, for your phone.
  It opens only through Cloudflare Access; set the two Access options to turn it on.

## 0.1.5

- Spending is never filed into a hidden category. Such a row goes to review instead, and your
  answer also fixes the rule that sent it there.

## 0.1.4

- New option **Leave out of reports**: categories the spend, income and compare reports skip, such
  as a one-off house purchase. The transactions stay searchable.

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
