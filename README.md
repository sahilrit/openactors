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

```json
{
  "mcpServers": {
    "openactors": {
      "command": "npx",
      "args": ["tsx", "/Users/sahilsachdeva/Documents/openactors/src/server.ts"]
    }
  }
}
```

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

Greenhouse, Lever, Ashby and SmartRecruiters adapters are verified against live
boards. Workable and Recruitee are written from their documented shapes but were
never exercised against a populated board — every one reachable during
development had zero open roles. They are marked `verified: false` in
`providers.ts` and the run log says so when you use them.

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

## Limits, stated plainly

- Free for sites that don't fingerprint hard. Google Maps and LinkedIn will
  eventually need residential IPs; that is a `PROXY_URL` change, not a rewrite.
- Run history is in memory and is lost on restart. Scraped results are on disk
  and are not.
- Respect the terms of service of whatever you point this at.

## License

MIT
