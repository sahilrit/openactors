# openactors

A free, self-hosted MCP server that exposes web scrapers as Apify-compatible
Actors. Point any MCP client at it instead of a paid scraping service.

Tool names match [`mcp.apify.com`](https://mcp.apify.com), so an existing client
config works after changing one line.

## Why this exists

`mcp.apify.com` is four layers, and only two of them are worth paying for:

| Layer | Reality |
|---|---|
| The MCP server | [MIT-licensed and open source](https://github.com/apify/apify-mcp-server). A few hundred lines of glue over a REST API. |
| The platform — datasets, key-value stores, run records | [Crawlee](https://crawlee.dev), MIT, and it *is* Apify's own engine. Free to self-host. |
| ~62,000 Store Actors | Third-party and proprietary. The actual product. |
| Residential proxy IPs | ~$1–4/GB. The actual moat. |

openactors reimplements layer 1, reuses layer 2 wholesale, and rewrites only the
handful of Actors worth having. It is free for targets that don't need rotating
residential IPs — which covers documentation, blogs, public JSON APIs, and most
of the open web.

**It is not a clone of the Apify Store.** Unknown Actor ids return a clear error
rather than pretending to work.

## Install

```bash
npm install && npm run build
```

## Connect

Local, over stdio — the normal case:

```json
{
  "mcpServers": {
    "openactors": {
      "command": "node",
      "args": ["/absolute/path/to/openactors/dist/src/server.js"]
    }
  }
}
```

Remote, over HTTP:

```bash
AUTH_TOKEN=$(openssl rand -hex 24) PORT=8080 npm run start:http
```

```json
{
  "mcpServers": {
    "openactors": {
      "url": "https://your-host/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

The HTTP server is stateless per request, like Apify's hosted one, but shares a
single run history across them so `get-actor-run` can still find a run that
`call-actor` just reported. `/health` lists the installed Actors.

**Set `AUTH_TOKEN` before exposing the port.** This server runs arbitrary
scrapers on request; an open one is someone else's scraping proxy. It is
optional only so that local use stays frictionless, and the server warns at
startup when it is unset.

## Docker

```bash
docker build -t openactors .
docker run -p 8080:8080 -e AUTH_TOKEN=... -v openactors-storage:/app/storage openactors
```

Built on the Playwright image, because `maps/google-maps` needs a real browser
and its system libraries are the tedious part. The image tag tracks the
`playwright` dependency — bumping one without the other fails at browser launch
rather than at build time.

## Tools

Discovery-based, following Apify's design: rather than one tool per scraper,
a few meta-tools let the agent discover capabilities at runtime. That's what
lets the Actor count grow without bloating the tool list.

| Tool | Purpose |
|---|---|
| `search-actors` | Find an Actor by keyword |
| `fetch-actor-details` | Read its input JSON Schema |
| `call-actor` | Run it; returns a preview plus a `datasetId` |
| | `waitSecs` controls how long to wait — see below |
| `get-actor-run` / `get-actor-run-list` | Status and history of runs |
| `get-actor-log` | Per-item failures that didn't fail the whole run |
| `abort-actor-run` | Stop a run in progress; keeps what it collected |
| `get-dataset-items` | Page through results, optionally projecting fields |
| `get-dataset` / `get-dataset-schema` | Item count; inferred field shape |
| `get-key-value-store-record` | Read a stored record by key |

### Long runs

MCP clients abandon a request after about sixty seconds, which is far short of
a crawl that reads a page per item. `call-actor` therefore *starts* a run and
waits only `waitSecs` for it (default 50, under that limit). If the run is
still going you get the `runId` back with `stillRunning: true`, and poll
`get-actor-run` until it finishes, then read results with `get-dataset-items`.
`waitSecs: 0` returns immediately.

This matters more than it sounds: without it, the request dies while the work
carries on invisibly, and nobody is holding the id needed to find it again.
Over REST the same control is `?waitForFinish=`, matching Apify's parameter.

Tool results are capped at a character budget and tell you how to page for the
rest, because a scraped page can be tens of thousands of characters and a tool
result goes straight into the agent's context.

## Actors

| Actor | Replaces | Notes |
|---|---|---|
| `web/site-crawler` | `apify/website-content-crawler` | Any site → clean Markdown. Boilerplate stripped via Readability. Runs from your own IP. |
| `jobs/ats-boards` | paid ATS scrapers | Open roles straight from Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee. **No scraping** — these are the public no-auth JSON APIs each ATS publishes so companies can embed listings. Nothing to block. |
| `web/rag-browser` | `apify/rag-web-browser` | Search the web and get the top results as Markdown in one call. Tries Brave, then DuckDuckGo. |
| `maps/google-maps` | `compass/crawler-google-places` | Local businesses with rating, category, address and phone. Drives a real browser — the slowest and most fragile Actor here. |
| `linkedin/jobs` | LinkedIn scrapers | Job listings from LinkedIn's public endpoint. No account, no cookie, no browser. |

### linkedin/jobs

Uses the endpoint LinkedIn's own logged-out job search calls, so **no account,
cookie or login is involved** and there is nothing that can be restricted. Plain
HTTP, no browser, paced three seconds between pages.

```json
{ "keywords": "performance marketing", "location": "United Kingdom", "remoteOnly": true, "postedWithinDays": 30 }
```

Both filters were checked against live data rather than assumed: `f_TPR` is
exact (a one-day window returns only today and yesterday; ninety days reaches
back to July), and `f_WT` is real — remote and on-site result sets are
near-disjoint. LinkedIn's own labelling is imperfect though, so an occasional
listing whose title says on-site still comes through under `remoteOnly`.

Pages hold ten postings and consecutive offsets are disjoint, so paging advances
by the number of cards received. Results are deduplicated by URL with tracking
parameters stripped.

## Console

```bash
AUTH_TOKEN=secret npm run start:http   # then open http://localhost:8080
```

A single page served by the server: browse Actors and run them with arbitrary
input, watch runs with their duration, memory and item counts, read logs,
manage schedules and tasks, and download any dataset as JSON, CSV or Excel.

Self-contained — no CDN, no external fonts, nothing fetched from the network —
so it works offline and under a strict content policy, which is the right
default for a tool that runs scrapers on your own machine. The page itself is
served unauthenticated; every request it makes carries the token, so it reveals
nothing without one.

## Connecting Claude (OAuth + tunnel)

Claude's connector reaches your server **from Anthropic's cloud, not from your
machine**, so `localhost` is invisible to it and a local stdio server cannot be
used. It also speaks only OAuth — its UI has no field for a static token. Both
gaps are covered:

```bash
scripts/install-tunnel.sh                        # once
OAUTH_PASSWORD='something-long' scripts/tunnel.sh
```

That prints a public HTTPS URL. Paste `<url>/mcp` into Claude as a custom
connector; Claude discovers the OAuth endpoints, registers itself, and sends you
to a consent page that asks for `OAUTH_PASSWORD`.

The consent step is not ceremony. Auto-approving would let anyone who found the
URL complete the flow and mint a token for a server that runs arbitrary
scrapers on your machine. For the same reason, the launcher **refuses to open a
tunnel if something is already listening on the port** — it would otherwise
publish that other server, which may have no authentication at all.

Tokens and client registrations survive a restart, so restarting the server does
not force you to re-add the connector.

### A permanent URL

A quick tunnel's hostname changes every restart, which means re-adding the
connector each time. For a stable one:

```bash
.bin/cloudflared tunnel login                       # once; opens a browser
scripts/named-tunnel.sh setup jobs.yourdomain.com
OAUTH_PASSWORD='…' scripts/named-tunnel.sh run jobs.yourdomain.com
OAUTH_PASSWORD='…' scripts/named-tunnel.sh install jobs.yourdomain.com   # start at login
```

This needs **a domain on your Cloudflare account** — Cloudflare's constraint,
not this script's: named tunnels route through a zone you control, and there is
no free Cloudflare-provided hostname for them. Any domain works, including one
already on Cloudflare for something else; a subdomain is enough.

`install` registers two launchd agents — one for the tunnel, one for the server
— that start at login and restart if they die, which is what makes the URL
genuinely permanent rather than merely stable.

Two agents invoking their binaries directly, rather than one agent running a
shell script: macOS denies `/bin/bash` access to `~/Documents`, so a
shell-based agent dies instantly with "Operation not permitted" while the same
command works from a terminal. Agent logs go to `~/Library/Logs/openactors/`
for the same reason — launchd cannot create files in `~/Documents`, and the
symptom is an agent with a healthy PID and completely empty logs.

**A DNS caveat worth knowing:** some ISP resolvers return NXDOMAIN for
`*.trycloudflare.com`. Claude is unaffected — it resolves through its own DNS —
but *your* browser may not open the consent page. Point your Mac at 1.1.1.1 or
8.8.8.8 (System Settings → Network → DNS) if that happens.

## REST API

Paths mirror Apify's, including its `~` separator for namespaced Actor ids — a
`/` in an id is otherwise indistinguishable from a path separator, which is
exactly why Apify chose `~`. A client written against Apify's API mostly needs
its base URL changed.

```bash
AUTH_TOKEN=secret npm run start:http

curl -H "Authorization: Bearer secret" localhost:8080/v2/acts
curl -H "Authorization: Bearer secret" -X POST localhost:8080/v2/acts/jobs~ats-boards/runs \
     -d '{"boards":["ashby:linear"],"titleIncludes":["engineer"]}'
curl -H "Authorization: Bearer secret" "localhost:8080/v2/datasets/<id>/items?format=csv&fields=title,url"
```

| Endpoint | Purpose |
|---|---|
| `GET /v2/acts` · `GET /v2/acts/:id` | List Actors; read one with its input schema |
| `POST /v2/acts/:id/runs?timeout=` | Start a run |
| `GET /v2/actor-runs` · `/:id` · `/:id/log` | Run history, detail, log |
| `POST /v2/actor-runs/:id/abort` · `/resurrect` | Stop a run; re-run a finished one |
| `GET /v2/datasets/:id` · `/:id/items` | Item count; export (see below) |
| `GET /v2/key-value-stores/:id/records/:key` | Read a stored record |
| `GET/POST /v2/actor-tasks` · `DELETE /:id` · `POST /:id/runs` | Saved Actor configurations |

**Input is validated against the Actor's schema before a run starts**, as Apify
does. A misspelled parameter returns `400` naming the unknown field rather than
running a full crawl that silently ignores it and returns plausible, wrong
results. Schema defaults are applied, and numeric strings from query parameters
are coerced.

### Exports

`?format=` accepts `json`, `jsonl`, `csv`, `xml`, `html`, `rss` and `xlsx`, with
`fields=`, `omit=` (which wins over `fields`, as on Apify), `clean=1` to drop
`#`-prefixed debug fields, and `attachment=1` for a download filename.

### Run states

The full Apify set: `READY`, `RUNNING`, `TIMING-OUT`, `ABORTING`, `SUCCEEDED`,
`FAILED`, `TIMED-OUT`, `ABORTED`. The distinctions matter — a run that exceeded
its limit is a different diagnosis from one a caller stopped, and an earlier
version reported both as `ABORTED`, making a too-short timeout look like user
action. Items collected before a timeout are kept.

Runs are **persisted**, so a run started by the scheduler is inspectable from
the REST API or an MCP client, and survives a restart. A run found still
`RUNNING` at startup is recorded as failed — its process is gone and nothing
will finish it.

## Webhooks

```bash
cp webhooks.example.json webhooks.json    # or just set WEBHOOK_URL
```

Events use Apify's names — `ACTOR.RUN.CREATED`, `.SUCCEEDED`, `.FAILED`,
`.ABORTED`, `.TIMED_OUT`, `.RESURRECTED` — and the payload carries the same
`actorId` / `actorRunId` / `resource` shape, so a consumer written for Apify
keeps working.

Each webhook may filter by `events` and by `actors`. Delivery retries three
times with backoff, treats a non-429 4xx as a settled rejection rather than
retrying it, and can never change a run's outcome: a dead endpoint is logged
against the run and nothing more.

## Process isolation

Every Actor runs in its own child process. The server never imports Actor code.

This is not defensive decoration. Scraper code drives browsers and parses
hostile HTML, and three failure modes will otherwise take down the MCP server
and the scheduler that depends on it:

| Failure | In-process | Isolated |
|---|---|---|
| `process.exit()` or a segfault | Server dies | Run reports `FAILED`, items already written are kept |
| Throw from a stray callback | Server dies | Run reports `FAILED` with the message |
| Synchronous infinite loop | **Unrecoverable** | Killed at the timeout |
| Runaway allocation | Machine memory exhausted | Killed at the heap ceiling |

The infinite loop is the case that settles the design: a loop that never yields
cannot be interrupted by an AbortController, a timer, or a promise rejection,
because none of them ever get to run. Only killing the process works, and only
a separate process can be killed.

An abort asks the Actor to stop first — a cooperative Actor checking
`ctx.signal` exits cleanly and keeps its results — and escalates to `SIGKILL`
only after a grace period, since an Actor ignoring the abort is exactly the one
a catchable signal will not stop either.

`memoryMbytes` (MCP) and `?memory=` (REST) set the heap ceiling, default 2048.

**The cost is about 420ms per run** for the fork and module load. That is real,
and it is why this is worth stating rather than burying: for a crawl measured in
seconds it is noise, and for a run-every-six-hours digest it is irrelevant. If
you ever need thousands of tiny runs a minute, this is the trade to revisit.

## Anti-blocking

Requests carry complete, internally consistent browser headers from Apify's own
`header-generator`, rather than a hand-written User-Agent whose `sec-ch-ua` and
`Accept` headers contradict the browser it claims to be. One identity is held
per session — changing browser between pages of a single crawl is itself
anomalous — and a 429 or 403 rotates it, since retrying with the identity that
just got refused repeats the failed request. Crawlee's session pool is enabled
for crawls, and browser runs jitter their viewport.

## Daily digest

Saved searches, run on a schedule, reporting only what you have not already
seen. This is what turns the Actors from something you remember to run into
something that works while you sleep.

```bash
cp searches.example.json searches.json   # then edit
npm run digest
```

Each search names an Actor and its input:

```json
{
  "searches": [{
    "name": "Performance marketing in India, posted this week",
    "actor": "linkedin/jobs",
    "input": { "keywords": "performance marketing", "location": "India", "eligibleFrom": "IN" },
    "display": ["title", "company", "location", "postedAt"]
  }],
  "output": { "dir": "digests", "keepDays": 90 }
}
```

Output is written to `digests/YYYY-MM-DD-HHMM.md` and `.html`, plus `latest.*`.
Filenames carry the time, not just the date: a digest reports what is new *since
the last run*, so on a sub-daily schedule two runs sharing a date-only name
would overwrite each other and the earlier results would be lost.

Items are recognised by `url` (override with `key`), and a key is remembered for
`keepDays` — comfortably longer than a posting stays listed, or an old role
would fall out of memory and be reported as new again. An item with no usable
key counts as new: showing a role twice is a smaller failure than never showing
it. A search that fails is reported in the digest rather than taking the other
searches down with it, and state is saved only after every search completes, so
an interrupted run cannot mark items seen that were never reported.

Renaming a search resets its history — names key the state.

### Knowing when a search has broken

A scraper whose target changed returns nothing, and in a digest that is
indistinguishable from a quiet week — so the digest keeps arriving, keeps
looking healthy, and keeps saying nothing new for as long as nobody checks.

Each search's total yield is tracked across runs. A collapse to under a fifth
of normal is flagged at the top of the digest, escalates to `broken` if it
persists, and makes the run exit non-zero so a scheduler surfaces it.

Three details decide whether this is useful or just noise:

- **Judged on total scraped, not on what is new.** "New" legitimately falls to
  zero once a search has caught up; total does not.
- **The baseline is the 75th percentile**, which has to survive two opposite
  failure modes. A plain median lets a sustained breakage rewrite normal — once
  the broken runs outnumber the healthy ones it sinks to meet them and the
  alert vanishes exactly when it matters. Anchoring on the maximum fixes that
  and hands the baseline to a single freak run, after which everything looks
  broken.
- **A search that has never returned anything is never flagged.** The
  globally-open watch is legitimately empty most days, and alerting on it would
  train you to ignore the alerts.

### Duplicates and decisions

Several searches legitimately match the same posting — four keyword variants
over one job market overlap heavily. Roles are deduplicated **across searches
within a run**, so a job appears once rather than in every section that matched
it. In practice that is around 30 rows a run here.

Roles you have marked stop appearing at all:

```
mark-job    urls: [...]  mark: applied | ignored
get-marked-jobs
unmark-job  urls: [...]
```

That is what separates a working list from a feed: without it every role you
have already decided about comes back forever, and the only record of your own
decisions is your memory.

**On volume:** LinkedIn returns a rotating sample of a large corpus rather than
the whole thing, so early runs surface a lot that is technically new to you. It
settles as the seen-set fills. Narrowing `postedWithinDays` shrinks the corpus
and settles it faster.

## Scheduling

Two ways, and the in-app one is now the default recommendation.

### In-app schedules

Managed over REST or MCP and run by the server itself, so they are portable,
inspectable and editable from a client:

```bash
curl -X POST localhost:8080/v2/schedules -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"jobs-6h","cron":"0 */6 * * *","task":"remote-growth","timezone":"Asia/Kolkata"}'
```

A schedule points at either an Actor with inline `input`, or a saved task. The
cron expression is validated when the schedule is saved rather than when it
fires — a schedule that silently never runs is far harder to notice than one
that refuses to be created. `nextRunAt` is written *before* the run starts, so a
run that overruns its interval cannot be started twice.

### launchd (macOS)

Still supported for the digest specifically, since it survives reboots without
the server running:



```bash
./scripts/schedule.sh install                      # daily at 08:00
DIGEST_EVERY_HOURS=6 ./scripts/schedule.sh install # 00:00, 06:00, 12:00, 18:00
./scripts/schedule.sh status
./scripts/schedule.sh run                          # once, exactly as the scheduler would
./scripts/schedule.sh uninstall
```

`DIGEST_EVERY_HOURS` must divide 24; `DIGEST_HOUR` and `DIGEST_MINUTE` offset
the times. Sub-daily schedules use fixed clock times rather than an interval
timer, which would drift and restart from zero on every reboot.

launchd rather than cron: it survives reboots, needs no always-running process,
and catches up a run missed because the Mac was asleep — which matters for a
laptop that is not reliably awake at 08:00. Logs land in `logs/`.

The agent runs the built `dist/` output, so **re-run `npm run build` after
changing an Actor** or the schedule keeps running the old code.

## Proxies

Everything works from your own IP by default, which is what makes it free. When
a target starts blocking, this is the seam.

**What this is and is not.** Residential IPs are rented from a provider; no
amount of code produces them. What is software here is the *other* half of
Apify Proxy — session stickiness, rotation, country targeting and ban handling —
and that is what this implements, with the provider left pluggable.

Simplest form, unchanged:

```bash
PROXY_URL=http://user:pass@host:port
```

For a residential gateway, `proxy.json` (or the `PROXY_*` variables):

```json
{
  "mode": "gateway",
  "preset": "iproyal",
  "user": "your-account",
  "password": "your-password",
  "country": "US",
  "sessionTtlSecs": 1800
}
```

Presets exist for `apify`, `iproyal`, `oxylabs`, `dataimpulse` and `evomi`.
Anything else works via a username template, because every vendor encodes the
same three parameters differently:

| Provider | Username shape |
|---|---|
| Apify | `groups-RESIDENTIAL,session-{session},country-{country}` |
| IPRoyal | `{user}-country-{country}-session-{session}` |
| Oxylabs | `customer-{user}-cc-{country}-sessid-{session}` |
| DataImpulse | `{user}__cr.{country};sid.{session}` |

`{session}`, `{country}` and `{user}` are substituted; a template whose
placeholder is empty is cleaned up rather than left with stray separators that
would break authentication.

**Sessions are keyed on the run id**, so one run holds one address across all
its requests. This matters more than raw rotation: a crawl that changes IP
between pages looks *less* like a person, not more. Sessions expire after
`sessionTtlSecs` (default 30 minutes, matching how residential pools recycle),
and the same session drives both the exit IP and the generated browser
fingerprint — a request arriving from a new address wearing the old fingerprint,
or the reverse, is more distinctive than either change alone.

A 403 or 429 counts a strike against the session; two retires it. One block can
be bad luck, and discarding a working address for it burns the pool faster than
the blocks do.

`GET /health` reports whether a proxy is active, its mode, country and live
session count — never the credentials.

**Cost, so the trade is explicit:** residential bandwidth runs roughly
$1–4/GB. Only `maps/google-maps` at volume and heavy crawling need it; the ATS
job APIs, LinkedIn's public endpoint and ordinary site crawling do not.

## Composition and metrics

An Actor can run another:

```ts
const nested = await ctx.call('jobs/ats-boards', { boards: ['ashby:linear'] });
for (const job of nested.items) await ctx.pushData({ ...job, tagged: true });
```

The request goes back to the parent, so a nested run gets the same validation,
isolation and limits as any other rather than a second execution path with its
own rules. A nested run that does not succeed **throws** in the caller —
returning it quietly would let an Actor build results on top of a run that
produced nothing and report success for both. Nesting is capped at three levels.

Nested runs are exempt from the concurrency limit by necessity: the caller is
already holding a slot and waiting, so queueing the callee behind it would
deadlock outright at a limit of one.

Every run reports `peakMemoryMb`, `cpuMs` and `computeUnits` (gigabyte-hours,
the unit Apify bills in — the honest measure of what a run cost to execute,
whoever is paying). Memory is measured as RSS rather than heap, because the
browser and parser buffers a crawl uses live outside the JS heap.

## Limits and housekeeping

**Concurrency.** Runs are capped at `MAX_CONCURRENT_RUNS` (default: one less
than the core count). This became necessary the moment Actors moved into child
processes — each run is a real OS process with its own heap, so an unbounded
burst exhausts the machine rather than merely slowing it. Queued runs sit in
`READY`, which is exactly what that state means, so a client polling can tell
"queued" from "running". A run aborted while still queued gives its slot
straight back rather than starting work nobody wants.

**Storage retention.** Every run creates a dataset, so they accumulate — a few
hundred within a day of ordinary use. `clean-up-storage` (MCP) removes storages
past a retention window; stores holding configuration are never touched, and it
defaults to a dry run, because a cleanup that deletes on first acquaintance is
a trap.

`match` takes a regular expression on the storage name and waives the age
check, since a name is the more specific instruction of the two. Age alone
cannot separate throwaway storages from real ones when both were created the
same day — exactly the state a testing session leaves behind. An invalid
pattern is refused rather than treated as "match everything", which would
delete the lot. Pass `protect` to keep named storages regardless.

## Notes on fragility

## Composition and metrics

An Actor can run another:

```ts
const nested = await ctx.call('jobs/ats-boards', { boards: ['ashby:linear'] });
for (const job of nested.items) await ctx.pushData({ ...job, tagged: true });
```

The request goes back to the parent, so a nested run gets the same validation,
isolation and limits as any other rather than a second execution path with its
own rules. A nested run that does not succeed **throws** in the caller —
returning it quietly would let an Actor build results on top of a run that
produced nothing and report success for both. Nesting is capped at three levels.

Nested runs are exempt from the concurrency limit by necessity: the caller is
already holding a slot and waiting, so queueing the callee behind it would
deadlock outright at a limit of one.

Every run reports `peakMemoryMb`, `cpuMs` and `computeUnits` (gigabyte-hours,
the unit Apify bills in — the honest measure of what a run cost to execute,
whoever is paying). Memory is measured as RSS rather than heap, because the
browser and parser buffers a crawl uses live outside the JS heap.

## Limits and housekeeping

**Concurrency.** Runs are capped at `MAX_CONCURRENT_RUNS` (default: one less
than the core count). This became necessary the moment Actors moved into child
processes — each run is a real OS process with its own heap, so an unbounded
burst exhausts the machine rather than merely slowing it. Queued runs sit in
`READY`, which is exactly what that state means, so a client polling can tell
"queued" from "running". A run aborted while still queued gives its slot
straight back rather than starting work nobody wants.

**Storage retention.** Every run creates a dataset, so they accumulate — a few
hundred within a day of ordinary use. `clean-up-storage` (MCP) removes storages
past a retention window; stores holding configuration are never touched, and it
defaults to a dry run, because a cleanup that deletes on first acquaintance is
a trap.

`match` takes a regular expression on the storage name and waives the age
check, since a name is the more specific instruction of the two. Age alone
cannot separate throwaway storages from real ones when both were created the
same day — exactly the state a testing session leaves behind. An invalid
pattern is refused rather than treated as "match everything", which would
delete the lot. Pass `protect` to keep named storages regardless.

## Notes on fragility

The Actors are not equally durable, and it's worth knowing which is which:

- `jobs/ats-boards` is the most durable. It reads documented JSON APIs; a break
  would be a provider changing its public contract.
- `web/site-crawler` and `web/rag-browser` are moderately durable. Search engines
  reshape their result markup, which is why search tries more than one and says
  in the log which one answered.
- `maps/google-maps` is the least durable, by a distance. Google generates every
  class name in a Maps card, so parsing works off the card's *rendered text*
  instead — but Google still varies what it renders. Review counts, for example,
  appear on some cards and not others; absent means `null`, never zero. The
  parser is in `parse.ts`, separate from the browser driving, so it can be
  unit-tested against captured card text.

## Limits, stated plainly

- Free for sites that don't fingerprint hard. Google Maps at volume will need
  residential IPs; that is a `PROXY_URL` change, not a rewrite.
- `maps/google-maps` needs a browser. Playwright's bundled Chromium does not
  support macOS 12, so the launcher prefers your installed Google Chrome and
  falls back to bundled Chromium elsewhere.
- Free search has no SLA. Querying an engine from one IP without a key draws
  intermittent 429s; that is why there is a fallback chain rather than one engine.
- Run history is in memory and is lost on restart. Scraped results are on disk
  and are not.
- Respect the terms of service of whatever you point this at.

## What is and isn't verified

Worth being precise about, since "it's built" and "it's known to work" are
different claims:

**Verified end to end, against the live internet:** the MCP wire contract over
both stdio and HTTP; `web/site-crawler` (single and multi-page, with link
following); `jobs/ats-boards` against live Greenhouse, Lever, Ashby and
SmartRecruiters boards; `web/rag-browser` search and direct fetch;
`maps/google-maps` driving a real browser; the Apify actor-id aliases; and the
LinkedIn gate refusing to run.

**Unit tested:** the six ATS normalizers, the Google Maps card parser against
captured real card text, and the LinkedIn daily budget.

**Not verified:** the Workable adapter (no populated Workable board was reachable —
marked `verified: false` in `providers.ts`), and the Docker image (never built;
the base tag was confirmed to exist upstream, nothing more).

Note that the real bugs found so far were caught by *using* the tool, not by the
test suite: a second crawl silently returning nothing, and hybrid
roles being reported as remote. The suite now covers both.

## License

MIT
