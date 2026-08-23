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
| `linkedin/jobs` | LinkedIn scrapers | **Gated.** Job listings. Requires a burner-account cookie; see below. |

### linkedin/jobs

Disabled unless `LINKEDIN_BURNER_COOKIE` is set. It stays visible in
`search-actors` while gated, with the reason attached, so an agent can tell you
what to configure instead of reporting a missing tool.

**Use a throwaway account.** LinkedIn restricts accounts it detects scraping,
and losing your real profile in the middle of a job search is a bad trade for a
list of postings. Two limits are enforced in code rather than asked for politely:

- **80 requests per UTC day**, shared across every run and persisted to a
  key-value store, so separate calls cannot quietly add up to a ban.
- **Randomized 3–8 second delays**, because a machine-regular request rhythm is
  itself a detection signal.

The gate, the budget accounting and the credential-failure path are tested. The
extraction itself is **not** verified against live LinkedIn — that needs a burner
account, which development did not have. Treat the parsing as untested until you
run it.

### ats-boards

Boards are given as `ats:account`, where the account is the slug in the
company's job-board URL:

```json
{
  "boards": ["greenhouse:stripe", "lever:leverdemo", "ashby:ashby"],
  "titleIncludes": ["marketing", "growth"],
  "remoteOnly": true
}
```

Results carry both `remote` (a strict boolean) and `workplaceType`
(`Remote`/`Hybrid`/`OnSite` where the provider distinguishes them). `remoteOnly`
is strict: hybrid is not remote. This matters more than it sounds — Ashby's own
`isRemote` field is `true` for hybrid roles too, so Ramp's board reports 123
"remote" postings of which only 16 actually are. The adapter ignores that field
and reads `workplaceType` instead.

Greenhouse, Lever, Ashby, SmartRecruiters and Recruitee adapters are verified
against live boards. Workable alone is written from its documented shape and
never exercised against a populated board — every Workable account reachable
during development had zero open roles. It is marked `verified: false` in
`providers.ts`, and the run log says so when you use it.

## Writing an Actor

Create `actors/<namespace>/<name>/` with an `actor.json` (title, description,
tags, and a JSON Schema for `input`) and a `main.ts` exporting:

```ts
export async function run(input: MyInput, ctx: ActorContext): Promise<void>
```

`ctx` gives you `pushData()`, `log()`, `signal`, and `runId`. That is the entire
surface — an Actor never touches storage or MCP directly, so it can be tested on
its own. New Actors are picked up on the next `search-actors` call without a
restart.

**If your Actor uses Crawlee storage, key it on `ctx.runId`.** Crawlee's default
storages persist between runs, and reusing them makes the second run silently
crawl nothing.

## Testing

```bash
npm run typecheck
npm test              # normalizer unit tests, offline, against recorded fixtures
npx tsx tests/smoke.ts  # end-to-end over real MCP stdio, hits the live network
```

The unit tests cover the ATS normalizers — pure functions, and the thing most
likely to break silently, since a renamed upstream field turns every title into
`(untitled)` without raising anything.

The smoke test drives the server over real MCP stdio and performs live crawls
and live board fetches. It is the only thing that proves the wire contract and
the network behaviour together, which is why it runs against the real internet
rather than mocks.

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

**Not verified:** `linkedin/jobs` extraction (needs a burner account this build
did not have), the Workable adapter (no populated Workable board was reachable —
marked `verified: false` in `providers.ts`), and the Docker image (never built;
the base tag was confirmed to exist upstream, nothing more).

Note that the two real bugs found so far were both caught by *using* the tool,
not by the test suite: a second crawl silently returning nothing, and hybrid
roles being reported as remote. The suite now covers both.

## License

MIT
