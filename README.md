# actual-curator

Hands-off categorization and tagging for [Actual Budget](https://actualbudget.org).

Bank imports land in Actual with a payee, a memo and no category. actual-curator keeps every new
transaction categorized and tagged within one run (15 minutes by default), and asks you only about
the rows it is unsure of. Each answer becomes an Actual rule, so it never asks about that payee again.

```
new row in Actual
   │
   ├─ an Actual rule matches ───────────────► category (from the rule) + tags + #auto
   │
   ├─ classifier ≥ threshold (0.95) ────────► category + tags + #auto
   │
   └─ classifier unsure ────────────────────► tags + #auto #review   (no category)
                                                   │
                         you answer (in Actual or through the API)
                                                   │
                                                   ▼
                                  category set, #review removed, rule created
```

- **Tags on every row** (`#kids`, `#recurring`, `#essential`, …) in the notes, after the bank memo,
  never replacing it. Slice spend across categories; filter in Actual's UI.
- **Rules from answers, not from guesses.** Your answers become rules at once. A machine answer
  becomes a rule only after three identical confident answers for the payee, and is deleted if you
  later correct one of its rows.
- **Auditable.** Every decision, with the classifier's probabilities and the row's previous
  category and notes, goes to a monthly JSONL log before anything is written.
- **An HTTP API for assistants** (n8n, Node-RED, an LLM agent): search, net spend and income
  reports, the review queue with top-3 candidates, set a category, manage rules.
  See [`openapi.yaml`](openapi.yaml).

## Quick start

### Docker Compose

```bash
curl -O https://raw.githubusercontent.com/shaiu/actual-curator/main/docker-compose.example.yml
curl -o .env https://raw.githubusercontent.com/shaiu/actual-curator/main/.env.example
mv docker-compose.example.yml docker-compose.yml
# edit .env: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, CURATOR_TOKEN, one model key
docker compose up -d
curl localhost:5007/v1/health
```

Set `DRY_RUN=true` first: every decision is logged (`GET /v1/decisions`) and nothing is written.

### Home Assistant

Actual Curator is also a Home Assistant app (formerly called an add-on).

[![Open your Home Assistant instance and show the add app repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fshaiu%2Factual-curator)

Or add `https://github.com/shaiu/actual-curator` by hand (**Settings → Apps → Install app → ⋮ →
Repositories**) and install **Actual Curator**. The app is a thin wrapper over the same image; see
[`actual_curator/DOCS.md`](actual_curator/DOCS.md).

### From source

```bash
npm ci
node --env-file=.env src/main.ts      # Node 24+
npm run check                         # typecheck + tests
```

## Classifiers

| `CLASSIFIER_PROVIDER` | Confidence | Notes |
|---|---|---|
| `openrouter-jev` (default) | Calibrated probabilities from a typed decision model ([Jev](https://openrouter.ai/docs/guides/community/jev)) | Cheapest and fastest in our test |
| `anthropic` | The model's own estimate | Claude Haiku by default |
| `openai-compatible` | The model's own estimate | OpenAI, Groq, OpenRouter, or a local Ollama |

Self-reported confidence is less reliable than calibrated probabilities; with those providers,
watch the dry-run log before trusting the threshold. The default threshold (0.95) comes from a test
on 300 real, already-categorized rows; see
[`docs/notes/jev-spike.md`](docs/notes/jev-spike.md).

## Configuration

Everything is environment variables (listed in [`.env.example`](.env.example)) plus one YAML
vocabulary file (`$DATA_DIR/curator.yaml`, created from
[`config/curator.example.yaml`](config/curator.example.yaml) on first start): tags and their
meanings, category hints, payees whose name says nothing (payment apps, standing orders) and the
memo patterns that identify them instead.

To start from a YNAB history, `scripts/bootstrap-rules.ts` proposes payee → category rules from a
YNAB export (payees with at least 2 rows and 90% agreement) and creates them through the API.

## Privacy

The payee, memo, amount, account name and date of each row are sent to the classifier provider
you configure. Nothing else leaves the host. To keep everything local, point `openai-compatible` at
a local model. The API is protected by a bearer token and is meant for a LAN or tailnet, not the
internet.

## Prior art

[sakowicz/actual-ai](https://github.com/sakowicz/actual-ai) categorizes uncategorized Actual rows
with an LLM on a schedule and marks its guesses in notes; actual-curator borrows that convention.
It differs in using calibrated confidence, tagging every row, learning rules from answers, exposing
an API an assistant can review through, and shipping as a Home Assistant app.

## License

MIT
