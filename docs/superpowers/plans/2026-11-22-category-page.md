# Category Drill-down Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only page per category and month listing what went out, linked from every line on /budget.

**Architecture:** A second route on the existing `createBudgetPage` Hono app, with the same access check, CSP and styles. It reads `/v1/budget/status` (the line's numbers) and `/transactions?category=` (the rows) in-process through the same `ApiCall`, so the page never reimplements any math.

**Tech Stack:** TypeScript, Hono, vitest (`npm test`, `npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-11-22-category-page-design.md`

## Global Constraints

- Route `GET /budget/category?month=YYYY-MM&id=<category id>&lang=he|en`.
- No JavaScript. Reuse the CSP, `Cache-Control: no-store` and `Referrer-Policy` headers and the `budget_lang` cookie from `/budget`.
- Without `verify`: 404. With no token or a bad token: 403, the same as `/budget`.
- Hebrew is the default. Every user-visible string goes in both `T.he` and `T.en`, and category names are wrapped with `nm()` (`<bdi>`).
- Read-only: the page makes no write calls.
- Release curator 0.4.0 per `docs/releasing.md`: tag the PR head **before** merging, and merge with a merge commit.

## Review Focus

1. A split transaction: only the child in this category appears, with the child's amount. The store already returns children with `is_parent: false`. Test it in Task 1 with a row whose `category` is the id.
2. An `id` that is in no status line, in neither `unplanned` nor `excluded`, and not in `/categories` gets a 404 page with no rows, even if transactions exist for it (Task 1).
3. An `id` containing `"<>&` must never reach the HTML unescaped. It is used in links, so encode it with `encodeURIComponent` in hrefs (Task 1).
4. A refund (amount > 0) is shown green with "+", and a spend is shown without a minus (Task 1).
5. A month with no transactions shows the header and a "no transactions" line, not an empty table (Task 1).

---

### Task 1: The category page

**Files:**
- Modify: `src/http/budget-page.ts` (new loader, renderer and route; shared CSS moved to a `STYLE` constant both renderers use)
- Modify: `test/helpers/budget-http.ts` (`FakeStore.transactions` honours `category`; `FakeStore.categories()` can return seeded categories)
- Test: `test/http/budget-category.test.ts`

**Interfaces:**
- Produces: `export async function loadCategoryPage(api: ApiCall, o: { now: Date; month?: string; id: string }): Promise<CategoryPageData | null>`, which returns `null` when the id is unknown.
- Produces: `export type CategoryPageData = { month: string; today: string; id: string; label: string; line: StatusLine | null; off: OffPlan | null; rows: TxRow[] }`.
- `TxRow` = `{ id: string; date: string; payee: string | null; accountName: string; memo: string; amount: number }`. The amount is in agorot and signed, as `/transactions` returns it in `amount`.
- Produces: `export function renderCategory(v: CategoryPageData, lang: Lang): string` and `export const categoryHref = (month: string, id: string, lang?: Lang) => string`, which returns `/budget/category?month=…&id=<encoded>`.

- [ ] **Step 1: Write the failing tests** in `test/http/budget-category.test.ts`. Use the same `setup()`, `ok` and `signed` as `budget-page.test.ts`, with rows seeded on `groceries` in 2026-11:
  - `lists the category's rows for the month, newest first, and its status numbers`: rows on 11-05 and 11-18, one more in October, and one in another category. Only the two November rows appear, the 11-18 row first, and the line's `spent` matches `/v1/budget/status`.
  - `a split child shows with its own amount` (Review Focus 1).
  - `an unknown id is a 404 with no rows` (Review Focus 2): GET `/budget/category?month=2026-11&id=nope` gives status 404, and the body contains none of the seeded payees.
  - `escapes the id in links and the page` (Review Focus 3): an id of `x"><b>` gives a 404 body without `<b>`. Also, `categoryHref('2026-11','a&b')` contains `id=a%26b`.
  - `a refund is green with a plus; a spend has no minus` (Review Focus 4).
  - `an empty month says so` (Review Focus 5): `T.en.noTx` is `'No transactions this month.'`.
  - `an unplanned category shows only spent` (`line` null, `off` set): no "of ₪" budget text.
  - `needs Access like /budget`: 404 without `verify`, 403 with a bad token.
  - `summary`: `'2 transactions, largest: Shufersal ₪350'` in English. The largest is the row with the largest absolute outflow.
  - `month arrows keep the category`: the prev link is `?month=2026-10&id=groceries`, and no next link appears past next month (the same rule as /budget).
- [ ] **Step 2:** Run `npx vitest run test/http/budget-category.test.ts`. Expected: FAIL (imports missing).
- [ ] **Step 3: Implement.**
  - Load the label from the status `lines`, then `unplanned`, then `excluded`. If none has it, fall back to `GET /categories`. If the id is still not found, return `null` and the route sends a 404 with `T[lang].notFound`.
  - Load rows with `GET /transactions?category=<encoded id>&from=<month>-01&to=<month>-<last day>&limit=1000`. Keep the store's order (newest first).
  - The header shows the name, the month, and a back link `‹ /budget?month=…`. Use `t.spentOf` for a line, and `t.spentBal` for an off-plan category.
  - Each row shows date `DD/MM`, payee, account name, the memo in small text, and the amount. A refund is `+₪X` in `good`; a spend is `₪X`.
  - Add the strings to both languages:
    - `notFound`: `'Category not found.'` / `'הקטגוריה לא נמצאה.'`
    - `noTx`: `'No transactions this month.'` / `'אין תנועות החודש.'`
    - `summary(n, payee, amt)`: `` `${n} transactions, largest: ${payee} ${amt}` `` / `` `${n} תנועות, הגדולה: ${payee} ${amt}` ``
    - `back`: `'Back to the month'` / `'חזרה לחודש'`
  - Extend `FakeStore.transactions` to filter by `q.category`. Let tests set `FakeStore.cats` for `categories()`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: all tests pass, including the existing `budget-page.test.ts`.
- [ ] **Step 5: Commit** `feat(budget): per-category page listing what went out`.

### Task 2: Link every line on /budget

**Files:**
- Modify: `src/http/budget-page.ts` (`renderBudget`)
- Test: `test/http/budget-page.test.ts`

**Interfaces:**
- Consumes: `categoryHref(month, id)` from Task 1.

- [ ] **Step 1: Write the failing test** `every planned, unplanned and excluded line links to its category page`. The rendered /budget HTML contains `href="/budget/category?month=2026-11&amp;id=groceries"` for a daily line, a fixed line (rent), an unplanned one and the excluded `biz`. Proposal lines and moves (which have labels only) have no link.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Wrap `nm(l.label)` in `<a href="${esc(categoryHref(v.month, l.categoryId))}">` for daily, fixed, set-aside, unplanned and excluded rows. Keep the name's colour readable: add `a.cat{color:inherit}` to the style.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(budget): link each line to its category page`.

### Task 3: Release 0.4.0

- [ ] Follow `docs/releasing.md` exactly:
  1. Bump `package.json`, `package-lock.json` and `actual_curator/config.yaml` to `0.4.0`, and add a CHANGELOG entry to both changelogs.
  2. Open a PR and wait for CI.
  3. Tag the PR head `v0.4.0`, push the tag, and wait for the image build.
  4. Merge with a merge commit.
  5. Run `gh release create v0.4.0`.
- [ ] Hand Shai the HA update step. After he updates, check that `/budget/category?month=2026-11&id=<USA id>` loads behind Access.

### Task 4 (ausie, after 0.4.0 is live): the advisor sends the link

- [ ] In `agent/template/finance/ai.nanoco.nanoclaw/context/instructions.md`, under "The budget page", add this rule: when a message is about one line, end it with `https://curator.shaiungar.me/budget/category?month=YYYY-MM&id=<categoryId>`. The `categoryId` comes from the `budget_status` line.
- [ ] Run `npm run lint:persona` and the finance unit tests. Then open a PR, merge it, and confirm the finance restamp.
