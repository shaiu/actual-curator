# Actual Curator

A Home Assistant app (formerly called an add-on). Actual Curator watches your Actual budget and, every 15 minutes, files each new transaction:

1. **Your rules** (Actual applies them on import; the curator also applies simple payee rules to
   rows that arrived before the rule existed).
2. **A classifier** for rows no rule covers. A category is written only when the classifier is at
   least 95% sure (configurable).
3. **`#review`** for everything else: the row keeps no category until you answer.

Every row it touches also gets tags in its notes (`#kids`, `#recurring`, …) so you can slice spend
across categories, and `#auto` so you can always see what the machine did.

## Install

1. In Home Assistant, go to **Settings → Apps → Install app**, open the **⋮** menu (top right),
   choose **Repositories**, and add:
   ```
   https://github.com/shaiu/actual-curator
   ```
2. Install **Actual Curator** from the store.
3. Fill in the options (below) and start it. It starts in **dry run**: it logs what it would do and
   writes nothing.
4. Read the log for a few days (`GET /v1/decisions`, or the app's **Log** tab), then turn **Dry run** off.

## Options

| Option | What to put there |
|---|---|
| Actual server URL | Your sync-server as seen from Home Assistant. With the Actual app on the same machine and port 5006 mapped: `http://172.30.32.1:5006`. |
| Actual password | The password you log in to Actual with. |
| Actual sync ID | In Actual: **Settings → Show advanced settings → Sync ID**. |
| API token | Any long random string. Clients send it as `Authorization: Bearer <token>`. |
| Classifier | `openrouter-jev` (default), `anthropic`, or `openai-compatible`. Paste the matching key. |
| Category confidence threshold | 0.95 by default. Lower means fewer questions and more mistakes. |
| Dry run | On at first. Turn off when the decision log looks right. |
| Currency | Optional ISO code (`ILS`, `EUR`) shown to the classifier next to amounts. |
| Vocabulary file | `/config/curator.yaml`, created from the example on first start. |
| Telegram / Home Assistant notification | Where to alert if runs fail for an hour. |

### Which classifier

| Provider | Confidence | Data leaves your network |
|---|---|---|
| `openrouter-jev` | Calibrated (a typed decision model) | Payee, memo, amount go to OpenRouter |
| `anthropic` | The model's own estimate | Same, to Anthropic |
| `openai-compatible` | The model's own estimate | Not if it points at a local model (Ollama) |

## What the tags mean

- `#auto`: the curator wrote this row. It will not touch it again unless you change it.
- `#review`: it was not sure. Set a category in Actual (or answer through an assistant) and the
  next run removes `#review` and creates a rule, so the same payee is never asked about again.
- Everything else comes from your vocabulary file.

If you change the category of an `#auto` row yourself, the curator notes it and deletes any rule it
had learned on its own for that payee. It never turns a one-off edit into a rule.

## Editing the vocabulary

The file is `curator.yaml` in this app's config folder (`/config` inside the app; on the host it is
the folder ending in `_actual_curator` under `addon_configs`, reachable with the File editor or Samba
apps). It holds:

- `tags`: each tag with the one-line meaning the classifier is told, and an optional threshold.
- `exclusive`: pairs where only the more likely tag is written.
- `categoryHints`: one-line hints for categories whose names are ambiguous, keyed `Group / Category`.
- `genericPayees`: payees whose name says nothing (payment apps, standing orders). Rules for these
  also match on a phrase from the memo.
- `reviewPayees`: payees whose rows always go to `#review` unless a rule already set the category
  (person-to-person transfers). Your answer creates a rule, so the next matching transfer is categorized.
- `memoKeyPatterns`: regexes that pull that phrase out of the memo.

Restart the app after editing.

## HTTP API

Port 5007, all routes under `/v1`, documented in
[`openapi.yaml`](https://github.com/shaiu/actual-curator/blob/main/openapi.yaml). `GET /v1/health`
needs no token.

Why a port: assistants, scripts and n8n flows read reports and answer `#review` rows through this
API, and they usually run outside Home Assistant. Every route except health needs the API token.
Keep the port on your LAN or tailnet; it is not meant for the internet. To turn it off, clear the
port in the app's **Network** settings; the curator keeps running.

## Known limitations

- One budget per app. Multi-currency budgets are not handled specially.
- The classifier sees payee, memo, amount, account name and date. With `openrouter-jev` or
  `anthropic`, those leave your network (see the classifier table).
- Rules the curator creates match the bank's `imported_payee` text. A bank that changes how it
  writes a payee name needs a new rule.
- With **Dry run** on, nothing is written by the scheduled runs, but answers sent through the API
  (`POST /v1/transactions/{id}`, `POST`/`DELETE /v1/rules`) are still written: they are your decisions.
- Experimental: 0.x versions may change options and the vocabulary format. Read the changelog
  before updating.

## Help

Questions and bug reports: <https://github.com/shaiu/actual-curator/issues>. Include the app log
and, for a wrong category, the line from `GET /v1/decisions` (remove anything private).

## License

MIT. See [LICENSE](https://github.com/shaiu/actual-curator/blob/main/LICENSE).
