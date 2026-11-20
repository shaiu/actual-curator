# Budget Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic envelope-budget engine to actual-curator. It stores a household plan, proposes how to fund a month from money that has landed, writes approved amounts and moves to Actual, and reports pace with alert events.

**Architecture:** There is a new `src/budget/` module made of pure functions (validate the plan, propose, pace, suggest moves, build events) plus file-backed state under `$DATA_DIR/budget/`. `ActualStore` gains two methods that read and write budget months. A new `src/http/budget.ts` registers `/v1/budget/*` routes on the existing Hono app. Every amount is computed in code. The calling LLM agent never computes.

**Tech Stack:** TypeScript on Node ≥24, run directly (`node src/main.ts`). Hono, zod 4, vitest, `@actual-app/api` 26.10.

**Spec:** `/Users/shaiungar/git/ausie/docs/superpowers/specs/2026-11-20-finance-advisor-design.md` (on branch `docs/finance-advisor-design`, commit 7a06e2d). Read sections Design 1–4, "Settled after the builder check" and Non-goals.

Plan 2 (the ausie MCP tools, the `finance` group and the knowledge base) is separate and consumes this plan's HTTP API.

## Global Constraints

- **Units.** Inside the code, every amount is an integer in minor units (agorot), the same as the rest of the curator. Responses use `money(minor)` from `src/http/format.ts`. **Request bodies take shekels** as numbers with at most 2 decimals; convert with `Math.round(x * 100)`. An LLM caller would get agorot wrong.
- **"Today" and the current month are in `Asia/Jerusalem`**, through `Intl.DateTimeFormat`. They are never UTC, because the HA container runs on UTC.
- **Past months are read-only.** propose, apply and move reject a `month` before the current month with 400 `past_month`.
- **Excluded categories never appear** in propose, status or suggested moves. Inbal's business category is `kind: 'excluded'`. Excluded spending is reported only as one `excludedSpentLastMonth` total.
- **A `protected` category is never a move source.**
- **Never fund more than is available:** the sum of proposed amounts ≤ the month's `toBudget`.
- **The plan is not seeded in code.** With no plan saved, `GET /budget/plan` returns `{plan:null}` and propose/status return 409 `no_plan`.
- **A plan category that is missing or hidden in Actual** makes propose, apply and status return 409 `stale_plan`, with the category ids in the message. It is never skipped silently.
- **Files** live under `$DATA_DIR/budget/`: `plan.json`, `plan-history.jsonl`, `writes.jsonl` and `state.json`. Write each one atomically: write `*.tmp`, then rename.
- **Release** as `0.2.0` following `docs/releasing.md`.

## Review Focus

1. **The first days of a month.** Projecting from day 1–6 explodes: ₪200 spent on day 1 projects to ₪6,000. So an "off by projection" result applies only from day 7. Before day 7, a variable category is `off` only when its balance is negative. Test: `pace — day 2 large spend is watch at most`.
2. **Month rollover at midnight Jerusalem while UTC is still the previous day.** Test `currentMonth` at `2026-11-30T22:30:00Z`: the expected result is `2026-12`.
3. **Status called twice, or crashing before the ack.** Events are idempotent and keep coming back until acked. A salary row is never announced twice after an ack. Test: `status — acked income event not re-emitted, unacked one repeats`.
4. **A proposal that went stale between propose and apply,** because a new deposit or a manual edit changed To budget. Apply returns 409 `stale_proposal`. Test exists in Task 5.
5. **Moving more than the source category holds,** or moving from a protected or excluded category. Each is a 400 with a clear code. Tests exist in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/budget/types.ts` | zod `planSchema`, plus the types `Plan`, `PlanCategory`, `IncomeSource`, `MonthSnapshot`, `CategoryMonth` |
| `src/budget/dates.ts` | `jerusalemToday(now)`, `currentMonth(now)`, `daysInMonth(month)`, `monthsBetween(a,b)` |
| `src/budget/plan-store.ts` | `BudgetFiles`: plan read/write + history, writes journal, state (acked events) |
| `src/budget/propose.ts` | pure `checkPlan()`, `propose()`, `proposalId()` |
| `src/budget/pace.ts` | pure `pace()` and `suggestMoves()` |
| `src/budget/events.ts` | pure `buildEvents()` (income landed, transfer missing, pace changes, review backlog) |
| `src/actual/store.ts` | adds `budgetMonth(month)` and `setBudgeted(month, amounts)` |
| `src/http/budget.ts` | `registerBudgetRoutes(app, deps)` |
| `src/http/app.ts` | extends `ApiStore`/`ApiDeps` and calls `registerBudgetRoutes` |
| `src/main.ts` | constructs `BudgetFiles` and passes it in |
| `openapi.yaml`, `README.md`, `CHANGELOG.md` | documents the endpoints |

Tests mirror the source: `test/budget/*.test.ts`, `test/actual/store.test.ts` (extended) and `test/http/budget.test.ts`.

---

### Task 1: Plan types, dates and file-backed storage

**Files:**
- Create: `src/budget/types.ts`, `src/budget/dates.ts`, `src/budget/plan-store.ts`
- Test: `test/budget/types.test.ts`, `test/budget/dates.test.ts`, `test/budget/plan-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts — shekel fields stay shekels in the stored plan (human-edited); engine converts.
  export const planSchema: z.ZodType<Plan>;
  export type Kind = 'fixed' | 'variable' | 'setaside' | 'excluded';
  export type PlanCategory = { categoryId: string; kind: Kind; priority: number; amount?: number;
    target?: number; due?: string /* YYYY-MM */; protected?: boolean; note?: string };
  export type IncomeSource = { name: string; payee: string; expectedAmount: number; expectedDay: number;
    fixedTransfer?: boolean };
  export type Thresholds = { watchPct: number; watchMin: number; offPct: number; projectFromDay: number };
  export type Plan = { version: 1; categories: PlanCategory[]; incomeSources: IncomeSource[]; thresholds: Thresholds };
  export type CategoryMonth = { id: string; label: string; hidden: boolean; isIncome: boolean;
    budgeted: number; spent: number /* ≤0 */; balance: number };   // minor units
  export type MonthSnapshot = { month: string; toBudget: number; categories: CategoryMonth[] };
  // dates.ts
  export function jerusalemToday(now: Date): string;           // 'YYYY-MM-DD'
  export function currentMonth(now: Date): string;             // 'YYYY-MM'
  export function daysInMonth(month: string): number;
  export function monthsBetween(from: string, to: string): number; // inclusive count, '2026-12'→'2027-03' = 4
  // plan-store.ts
  export type BudgetState = { acked: Record<string, string /* iso */> };
  export class BudgetFiles {
    constructor(dataDir: string);                       // uses join(dataDir,'budget')
    plan(): Plan | null;
    savePlan(plan: Plan, meta: { by: string; why: string }, at: Date): void;   // appends plan-history.jsonl
    journal(entry: object, at: Date): void;             // appends writes.jsonl
    state(): BudgetState;
    ack(ids: string[], at: Date): void;
  }
  ```

- [ ] **Step 1: Write failing tests**
  - `types.test.ts`:
    - `plan — fills default thresholds`: parsing `{version:1,categories:[],incomeSources:[]}` gives `thresholds` equal to `{watchPct:15,watchMin:150,offPct:10,projectFromDay:7}`.
    - `plan — setaside needs target and due`: `{kind:'setaside',categoryId:'x',priority:1}` throws.
    - `plan — fixed/variable need amount`.
    - `plan — excluded rejects amount`.
    - `plan — due must be YYYY-MM`.
    - `plan — duplicate categoryId rejected`.
  - `dates.test.ts`:
    - `currentMonth(new Date('2026-11-30T22:30:00Z'))` is `'2026-12'`.
    - `jerusalemToday(new Date('2026-11-20T21:59:00Z'))` is `'2026-11-20'`.
    - `daysInMonth('2027-02')` is `28`.
    - `monthsBetween('2026-12','2027-03')` is `4`.
    - `monthsBetween('2026-12','2026-12')` is `1`.
  - `plan-store.test.ts` (temp dir):
    - `plan()` on an empty dir is `null`.
    - `savePlan` then `plan()` round-trips.
    - `plan-history.jsonl` has one line `{at,by,why,plan}` per save.
    - `ack(['a'])` then `state().acked.a` is the iso time.
    - No `*.tmp` file is left behind.

- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run test/budget`. Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three modules.**
  - `currentMonth` uses `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem'})`.
  - The schema uses `z.object(...).superRefine` for the per-kind rules and the duplicate check.

- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run test/budget && npx tsc`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit.** `git commit -m "feat(budget): plan schema, Jerusalem dates, file-backed budget state"`

---

### Task 2: Read and write budget months in `ActualStore`

**Files:**
- Modify: `src/actual/store.ts` (add 2 methods)
- Test: `test/actual/store.test.ts` (extend; uses `test/helpers/budget.ts`)

**Interfaces:**
- Consumes: `MonthSnapshot` and `CategoryMonth` from Task 1.
- Produces:
  ```ts
  async budgetMonth(month: string): Promise<MonthSnapshot>;
  // Sets ABSOLUTE budgeted values, all inside one api.batchBudgetUpdates, under this.locked.
  async setBudgeted(month: string, amounts: Record<string, number /* minor */>): Promise<void>;
  ```
  `budgetMonth` maps `api.getBudgetMonth(month)`. Each category's `budgeted`, `spent` and `balance` are already in minor units. `label` is `"Group / Name"`, as in `categories()`. `hidden` and `isIncome` come from the category and group flags. The month's `toBudget` comes from the result.

- [ ] **Step 1: Write failing tests** against the fixture budget, which has categories coffee and groceries and a bank with spends:
  - `budgetMonth — returns toBudget and per-category budgeted/spent/balance`: after `api.setBudgetAmount(m, coffee, 50000)`, the snapshot shows coffee `budgeted 50000`, and `spent` equals the sum of this month's coffee rows.
  - `setBudgeted — writes absolute amounts`: `setBudgeted(m,{[coffee]:30000,[groceries]:70000})`, then `budgetMonth(m)` shows those values.
  - `budgetMonth — hidden category flagged`: `old` has `hidden:true`.

- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run test/actual/store.test.ts`. Expected: FAIL, `budgetMonth is not a function`.

- [ ] **Step 3: Implement both methods.**

- [ ] **Step 4: Run them and check they pass.** Run `npx vitest run test/actual && npx tsc`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(store): read budget months and set budgeted amounts"`

---

### Task 3: Propose, the funding engine

**Files:**
- Create: `src/budget/propose.ts`
- Test: `test/budget/propose.test.ts`

**Interfaces:**
- Consumes: `Plan` and `MonthSnapshot` from Task 1.
- Produces:
  ```ts
  export class PlanError extends Error { constructor(code: 'no_plan' | 'stale_plan', message: string) }
  /** Throws PlanError('stale_plan') naming every plan categoryId missing from the snapshot or hidden. */
  export function checkPlan(plan: Plan, snap: MonthSnapshot): void;
  export type ProposalLine = { categoryId: string; label: string; kind: Kind; priority: number;
    planned: number; budgeted: number; propose: number; unfunded: number };   // minor
  export type Proposal = { month: string; proposalId: string; available: number; proposed: number;
    remaining: number; lines: ProposalLine[] };
  export function propose(plan: Plan, snap: MonthSnapshot): Proposal;
  /** sha256 of month + toBudget + every category's budgeted, sorted by id; first 12 hex chars. */
  export function proposalId(snap: MonthSnapshot): string;
  /** The month's planned amount for one plan category (minor units); used by propose and by pace (Task 4). */
  export function plannedAmount(c: PlanCategory, cat: CategoryMonth, month: string): number;
  ```
  The algorithm (this is the core decision, so it is stated exactly):
  ```
  planned(c) = fixed|variable: round(amount*100)
               setaside: max(0, ceil((target*100 − carryIn) / monthsBetween(month, due)))
                         where carryIn = balance − budgeted − spent   (balance before this month)
               excluded: skipped entirely (no line)
  remaining = snap.toBudget
  for c in plan.categories (non-excluded) sorted by (priority asc, label asc):
      need = max(0, planned − budgeted); give = min(need, max(0, remaining))
      remaining −= give; line.propose = give; line.unfunded = need − give
  ```
  A set-aside whose `due` is before the month counts `monthsBetween` as 1.

- [ ] **Step 1: Write failing tests**
  - `propose — fills by priority up to available`: toBudget ₪5,000. The plan is rent ₪4,000 (p1), dining ₪2,800 (p2). Expected: rent propose 400000, dining propose 100000 with unfunded 180000, remaining 0.
  - `propose — subtracts what is already budgeted`: dining has budgeted 200000 and planned 280000, so propose is ≤ 80000.
  - `propose — setaside spreads target over months to due`: target ₪6,000, due 3 months away inclusive, carryIn ₪1,500. Planned is 150000.
  - `propose — excluded category has no line`.
  - `propose — never exceeds toBudget; toBudget negative proposes 0 everywhere`.
  - `checkPlan — hidden or missing plan category throws stale_plan naming both ids`.
  - `proposalId — changes when toBudget or any budgeted changes, stable otherwise`.

- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run test/budget/propose.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Use `node:crypto` `createHash`.

- [ ] **Step 4: Run them and check they pass.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(budget): deterministic month funding proposal"`

---

### Task 4: Pace, suggested moves and events

**Files:**
- Create: `src/budget/pace.ts`, `src/budget/events.ts`
- Test: `test/budget/pace.test.ts`, `test/budget/events.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3 (`checkPlan`).
- Produces:
  ```ts
  // pace.ts
  export type PaceStatus = 'ok' | 'watch' | 'off';
  export type PaceLine = { categoryId: string; label: string; kind: Kind; budgeted: number; spent: number;
    balance: number; expectedByToday: number; projected: number; status: PaceStatus };
  export function pace(plan: Plan, snap: MonthSnapshot, today: string /* YYYY-MM-DD */): PaceLine[];
  export type Move = { from: string; fromLabel: string; to: string; toLabel: string; amount: number };
  export function suggestMoves(plan: Plan, lines: PaceLine[], today: string): Move[];
  // events.ts
  export type BudgetEvent =
    | { id: string; kind: 'income'; source: string; amount: number; date: string; transactionId: string }
    | { id: string; kind: 'transfer_missing'; source: string; expectedDay: number }
    | { id: string; kind: 'pace'; categoryId: string; label: string; status: 'watch' | 'off' }
    | { id: string; kind: 'review'; count: number };
  export type IncomeRow = { id: string; date: string; amount: number; payee: string | null;
    importedPayee: string | null; transferId: string | null };
  export function buildEvents(i: { plan: Plan; month: string; today: string; income: IncomeRow[];
    lines: PaceLine[]; reviewCount: number; acked: Record<string, string> }): BudgetEvent[];
  ```
  Pace rules. `d` = day of month and `D` = days in month. If the month is in the future, `d = 0`. If it is past, `d = D`. Spent is shown as a positive number.
  - **variable**:
    - `expected = round(budgeted*d/D)` and `projected = d>0 ? round(spent*D/d) : 0`.
    - **off** when `balance < 0`, or when `d ≥ projectFromDay` and `projected − budgeted ≥ offPct% × budgeted`.
    - Otherwise **watch** when `spent > expected × (1+watchPct/100)` and `spent − expected ≥ watchMin×100`.
    - Otherwise **ok**.
  - **fixed**: **off** iff `balance < 0`, otherwise ok.
  - **setaside**: **off** iff `balance < 0`. **watch** when `d ≥ 20` and `budgeted < plannedAmount(c, cat, month)` (Task 3).
  - A category with `budgeted = 0` and `spent = 0` is ok.

  `suggestMoves`, for each `off` line:
  - `shortfall = max(−balance, projected − budgeted)`.
  - The candidate sources are lines with kind `variable`, status `ok`, not `protected`, and not excluded.
  - `slack = balance − round(budgeted*(D−d)/D)`, and only `slack > 0` counts.
  - Take sources by slack descending until the shortfall is covered. Each amount is `min(slack, rest)`, rounded **up** to whole ₪10 but not above the slack.
  - The result is an empty list when no source has slack.

  Events. Only events whose `id` is not in `acked` are returned.
  - **income**: one per row of the month with `amount > 0` and `transferId === null`, where `importedPayee ?? payee` contains `source.payee`. The id is `income:<txId>`.
  - **transfer_missing**: for a `fixedTransfer` source with no matching row by `expectedDay + 3`. The id is `transfer:<month>`.
  - **pace**: one per line with status watch or off. The id is `pace:<month>:<categoryId>:<status>`, so moving from watch to off is a new event.
  - **review**: when `reviewCount > 0`. The id is `review:<today>`, so at most one per day.

- [ ] **Step 1: Write failing tests**
  - `pace — variable on track is ok`: day 15/30, budget ₪2,800, spent ₪1,400.
  - `pace — variable ahead is watch`: day 10/30, budget ₪2,800, spent ₪1,200. Expected is ₪933, and ₪1,200 > ₪1,073 with an excess of ₪267 ≥ ₪150, so watch.
  - `pace — projected overspend is off`: day 15, spent ₪1,700. Projected ₪3,400 is more than 10% over, so off.
  - `pace — day 2 large spend is watch at most` (Review Focus 1).
  - `pace — negative balance is off for every kind`.
  - `pace — fixed bill fully spent early is ok`.
  - `suggestMoves — picks the largest-slack ok variable source, rounds up to ₪10, skips protected and excluded`.
  - `suggestMoves — empty when no slack`.
  - `events — income matched by payee substring, transfers ignored`.
  - `events — transfer_missing only after expectedDay+3`.
  - `events — watch→off emits a new pace event`.
  - `status — acked income event not re-emitted, unacked one repeats` (Review Focus 3, at the pure level: call twice with the same `acked`, ack, call again).

- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run test/budget/pace.test.ts test/budget/events.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement both modules.**

- [ ] **Step 4: Run them and check they pass.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(budget): pace status, suggested moves and alert events"`

---

### Task 5: HTTP routes

**Files:**
- Create: `src/http/budget.ts`
- Modify:
  - `src/http/app.ts`: `ApiStore` adds `'budgetMonth' | 'setBudgeted'`. `ApiDeps` adds `budget: BudgetFiles`. Call `registerBudgetRoutes(app, deps, now)` before the `notFound` handler. Map `PlanError` in `onError` to 409 with its code. Allow `ApiError` status 409.
  - `src/main.ts`: `new BudgetFiles(cfg.dataDir)`.
- Test: `test/http/budget.test.ts`. Extend `FakeStore` with an in-memory `MonthSnapshot` per month, plus a temp-dir `BudgetFiles`.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces the HTTP contract that Plan 2's MCP tools call. All routes sit under `/v1`, behind the existing bearer auth.

| Route | Request | 200 response |
|---|---|---|
| `GET /budget/plan` | — | `{plan: Plan \| null}` |
| `PUT /budget/plan` | `{plan: Plan, by: string, why: string}` | `{plan}`. It runs `checkPlan` against the current month and returns 409 `stale_plan` if a category is unknown. |
| `GET /budget/propose?month=YYYY-MM` | month defaults to the current one | `{proposal: Proposal with money() amounts, landed: {source, amount, date}[], expected: {source, expectedDay}[], excludedSpentLastMonth: money}` |
| `POST /budget/apply` | `{month, proposalId, amounts: {[categoryId]: shekels ≥0}, approvedBy}` | `{month, applied: {categoryId,label,added,budgeted}[], toBudget}` |
| `POST /budget/move` | `{month, from, to, amount: shekels>0, approvedBy}` | `{month, from:{id,label,budgeted,balance}, to:{…}}` |
| `GET /budget/status?month=` | — | `{month, today, totals:{budgeted,spent,balance}, lines: PaceLine[], moves: Move[], events: BudgetEvent[]}` (money() on amounts) |
| `POST /budget/status/ack` | `{ids: string[]}` | `{acked: n}` |

Apply semantics:
- `amounts` are **added** to the current budgeted value. These are the "propose" numbers.
- The route recomputes `proposalId` from a fresh `budgetMonth`. A mismatch is 409 `stale_proposal`.
- The sum of the additions must be ≤ `toBudget`, otherwise 400 `over_available`.
- A category that is excluded, an income category or hidden gives 400 `bad_category`.
- On success it writes with `setBudgeted`, then calls `budget.journal({op:'apply',month,approvedBy,amounts})`.

Move semantics:
- `amount ≤ from.balance`, otherwise 400 `insufficient_balance`.
- A source that is protected or excluded gives 400 `protected_source`.
- It writes both absolute values in one `setBudgeted` call, then writes the journal.

Status:
- The route calls `store.sync()` first.
- `income` comes from `store.transactions({from: monthStart, to: monthEnd, limit: 1000})`.
- `reviewCount` comes from `store.transactions({tag:'review', …})` over the last 30 days.

- [ ] **Step 1: Write failing tests**
  - `GET plan — null before any save`.
  - `PUT plan — saves and records by/why`.
  - `PUT plan — unknown category → 409 stale_plan`.
  - `propose — no plan → 409 no_plan`.
  - `propose — past month → 400 past_month`.
  - `propose — returns lines with money() and the landed salary`.
  - `apply — writes added amounts and journals`.
  - `apply — stale proposalId → 409 stale_proposal` (Review Focus 4).
  - `apply — sum over toBudget → 400 over_available`.
  - `apply — excluded category → 400 bad_category`.
  - `move — moves between categories`.
  - `move — more than balance → 400 insufficient_balance`.
  - `move — protected source → 400 protected_source` (Review Focus 5).
  - `status — events repeat until acked, then not` (Review Focus 3, through HTTP).
  - `apply — shekel 2800 becomes 280000 minor`.

- [ ] **Step 2: Run them and check they fail.** Run `npx vitest run test/http/budget.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the routes and wire them in.**

- [ ] **Step 4: Run the full check.** Run `npm run check`. Expected: tsc clean and all tests pass, including the existing ones.

- [ ] **Step 5: Commit.** `git commit -m "feat(http): /v1/budget plan, propose, apply, move, status endpoints"`

---

### Task 6: Docs, release 0.2.0 and a live read-only smoke test

**Files:**
- Modify:
  - `openapi.yaml`: add the 7 operations with their schemas.
  - `README.md`: a short "Monthly budget" section explaining what the engine does and that amounts are deterministic.
  - `CHANGELOG.md` and `actual_curator/CHANGELOG.md`: a `0.2.0` entry.
  - Version bumps per `docs/releasing.md`.

- [ ] **Step 1:** Update `openapi.yaml`. Then check every route in `src/http/budget.ts` is listed: `grep -c "/budget/" openapi.yaml` should be ≥ 6.
- [ ] **Step 2:** Run `npm run check`. Expected: PASS.
- [ ] **Step 3:** Open the PR, wait for CI, and merge. Release `0.2.0` exactly as `docs/releasing.md` says: release branch, tag, wait for the image, then bump `main`.
- [ ] **Step 4: Hand off the HA update to Shai.** Give him click-by-click steps: HA → Settings → Apps → Actual Curator → Update, then check the Log shows `0.2.0`. Do not try the Supervisor restart from the session.
- **Not in this plan:** writing the plan `note` into Actual category notes (optional in the spec); the curator rule filing One Zero → Ready to Assign (created through the existing `POST /v1/rules` during Plan 2 rollout); the Sep/Oct rollover sanity check (first advisor session).
- [ ] **Step 5: Run a live read-only smoke test** through `http://192.168.68.125:8507` with `CURATOR_TOKEN` sent from a mode-600 header file:
  - `GET /v1/health` shows version `0.2.0`.
  - `GET /v1/budget/plan` returns `{"plan":null}`.
  - `GET /v1/budget/propose?month=2026-12` returns 409 `no_plan`.
  - Do not PUT a plan. The first plan is built with Shai and Inbal through the advisor (Plan 2).
