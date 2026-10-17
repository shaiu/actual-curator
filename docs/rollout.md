# Rollout checklist

Each step is a gate for the next. Commands assume a checkout of this repo and an env file outside
it (for example `~/.config/actual-curator/env`, mode 600) holding the variables from
`.env.example`.

## 1. Classifier spike — done

Result and decision: [`notes/jev-spike.md`](notes/jev-spike.md).
Default provider `openrouter-jev`, category threshold 0.95.

## 2. Dry run, locally, against the real budget

```bash
# in the env file: ACTUAL_SERVER_URL (LAN address of the sync-server), ACTUAL_PASSWORD, ACTUAL_SYNC_ID,
# CURATOR_TOKEN, OPENROUTER_API_KEY, CURRENCY, DATA_DIR=$HOME/.local/share/actual-curator, DRY_RUN=true
node --env-file=$HOME/.config/actual-curator/env src/main.ts
```

Look for, on the first run:

- [ ] The startup line shows `server 26.x` matching `@actual-app/api` and `DRY RUN`.
- [ ] `run: {"synced":true,"ok":true,…}` with `seen` close to the number of new rows in the last 60 days.
- [ ] **Bank rows carry `imported_payee`.** `GET /v1/decisions` lines have a non-empty
      `importedPayee` for rows written by the bank importer. If they are empty, rules cannot match
      and step 3 is pointless.

Then for a few days of real rows:

```bash
curl -s -H "Authorization: Bearer $CURATOR_TOKEN" "localhost:5007/v1/decisions?since=$(date -v-1d +%FT%T)" | jq '.decisions[] | {kind, importedPayee, memo, categoryConfidence, after}'
```

- [ ] `classified` rows: is the category right? Count the wrong ones.
- [ ] `review` rows: would you have been happy to be asked?
- [ ] Tags: are they plausible? Adjust meanings and thresholds in `curator.yaml`.

## 3. Bootstrap rules

```bash
CURATOR_TOKEN=… node scripts/bootstrap-rules.ts --export <ynab-export.json> --url http://localhost:5007          # dry run
CURATOR_TOKEN=… node scripts/bootstrap-rules.ts --export <ynab-export.json> --url http://localhost:5007 --apply
```

- [ ] "category not in Actual" lines are few and understood.
- [ ] **A rule created through the API categorizes the next import.** After the next bank scrape,
      a row from a bootstrapped payee arrives already categorized in Actual's UI (before the
      curator touches it).

## 4. Writes on, still local

Set `DRY_RUN=false`, restart. For a week:

- [ ] Filter Actual by `#auto`: spot-check categories.
- [ ] Filter by `#review`: answer a few in Actual's UI; the next run removes `#review` and
      `GET /v1/rules` shows a `human` rule for that payee.
- [ ] Change the category of an `#auto` row: the next run logs `ui-correction`.

## 5. Move to the Home Assistant app

- [ ] Install the app (see `actual_curator/DOCS.md`) with the same options and `dry_run: false`.
- [ ] Stop the local run. The app starts with an empty decision log: rules the local run
      created keep working, but their origin is unknown to the app, so it will never delete
      them on a correction. Copy `decisions/` and `rules.json` into the app's `/data` only if
      that matters.
- [ ] `GET http://<ha-host>:5007/v1/health` answers from the tailnet.

## 6. Assistant integration

Plan B (separate repo): an MCP server over this API, a review skill, a heartbeat check.

## 7. Retire the old budget tool

Two weeks after step 6 answers the same questions.

## 8. Publish

See [`releasing.md`](releasing.md). After the first release, make both GHCR packages
(`actual-curator`, `actual-curator-ha`) public, and check that an anonymous `docker pull` works.
