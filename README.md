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
| `get-actor-run` / `get-actor-run-list` | Status and history of runs |
| `get-actor-log` | Per-item failures that didn't fail the whole run |
| `abort-actor-run` | Stop a run in progress; keeps what it collected |
| `get-dataset-items` | Page through results, optionally projecting fields |
| `get-dataset` / `get-dataset-schema` | Item count; inferred field shape |
| `get-key-value-store-record` | Read a stored record by key |

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

**On volume:** LinkedIn returns a rotating sample of a large corpus rather than
the whole thing, so early runs surface a lot that is technically new to you. It
settles as the seen-set fills. Narrowing `postedWithinDays` shrinks the corpus
and settles it faster.

## Scheduling

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

Everything works from your own IP by default, which is what makes it free.
`PROXY_URL` is the single seam for changing that:

```bash
PROXY_URL=http://user:pass@host:port
```

It routes both HTTP requests and the browser. Nothing else needs to change —
no Actor knows or cares whether a proxy is configured.

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
