# turtle-soup-page

A shared scratchpad for playing turtle soup (lateral thinking puzzles). The URL suffix is the
room name — type one and the room exists. No accounts, no landing page.

```
https://<your-domain>/            → 302 to a freshly generated room name (22 chars, 128 bit)
https://<your-domain>/xyz123      → room "xyz123"; created on the spot if it does not exist
https://<your-domain>/誰要玩海龜湯     → non-ASCII room names are supported
```

Everyone on the same room name shares one document and sees edits immediately. Room names accept
letters, digits, `_` and `-`, 2 to 64 characters, and are NFC-normalised so that different
encodings of the same characters resolve to the same room.

## Architecture

- Frontend: `public/`, fully static, with no third-party resources (no CDN, no remote fonts).
- Backend: a Cloudflare Worker (`worker/index.js`) plus Durable Objects.
  - `Room`: one Durable Object per room. Single-threaded execution serialises every change, so no
    CRDT is required.
  - `Limiter`: caps room creation per hashed client IP (10 per hour, 60 per day).
- The server is the only writer. Every message from a client is treated as untrusted input and
  validated in `worker/validate.js`.

### Documents live in memory only

Rooms in a party tool are short-lived by nature, and high-frequency collaborative editing would
consume a large share of the daily storage-write allowance if every change were persisted. The
document is therefore **never written to storage** and exists only in the Durable Object's memory.
The single value that is persisted is each room's `lock` key, which is written at most a few times
a day.

The cost is that memory is lost whenever the object hibernates or restarts. Recovery is delegated
to the clients: every browser already holds a complete mirror of the document, so when the server
wakes up empty it broadcasts `need` and a client replies with `seed`. Content therefore survives a
page reload, a closed and reopened tab, a long pause, a dropped connection, and a redeployment.
The only case in which content is genuinely lost is **after everyone has disconnected**, which is
the correct behaviour for the end of a game.

A client only offers its copy when the server explicitly reports that it is empty, so stale content
cannot overwrite newer content. The browser-side copy is kept in `sessionStorage` rather than
`localStorage`: it disappears with the tab and cannot leak yesterday's content into a new room that
happens to reuse the same name.

## Security design

| Goal | Approach |
|---|---|
| Never become an XSS vector | Remote strings never reach `innerHTML`; user content is written only through `.value` and `.textContent`. Structural, not filter-based |
| Response headers | The Worker applies CSP (`default-src 'none'`), `frame-ancestors 'none'`, `no-referrer`, `nosniff` and HSTS |
| Input validation | Field allow-list, type checks, length caps, control- and zero-width-character stripping, NFC normalisation, 8 KB per message, 256 KB per document |
| Rate limiting | 5 ops/s per connection (burst 20), 32 concurrent peers per room, room creation capped per IP |
| Containment | `lock <room>` makes a single room read-only and takes effect immediately; `freeze` stops writes site-wide |
| Data minimisation | Documents are never persisted and disappear once everyone leaves; IPs are used only in hashed form for rate limiting and are not retained |
| No value as a spam host | `noindex` plus plain-text rendering (no hyperlinks) removes the SEO incentive |

**Explicitly out of scope, and accepted:** content is not confidential, since everyone in the room
can read the solution; there are no accounts, so actions cannot be attributed; a short,
self-chosen room name is effectively public and can be guessed (use a generated random name if
isolation matters); and **vandalism cannot be rolled back** — there are no snapshots, containment
is limited to `lock`, and recovery means moving to a new room name.

## Hosting from a local agent

`tools/host.mjs` joins a room as an ordinary client and plays the host: it posts the puzzle and
answers each question with `T` / `F` / `I`. The judgement is made by a local Claude Code session
(`.claude/skills/soup-host`); the CLI is transport plus enforcement only. Nothing in `worker/`
changes and the Worker still makes no LLM calls — the model runs outside the request path.

```bash
npm run host -- init   <room> --soup soups/<room>.json
npm run host -- wait   <room> --soup soups/<room>.json     # blocks up to 9 min, prints pending questions
npm run host -- answer <room> <row> <T|F|I> --soup soups/<room>.json [--note "…"]
npm run host -- reveal <room> <room> --soup soups/<room>.json
```

### Choosing the target site

Every subcommand takes `--host <origin>`, which decides where the bot connects. It defaults to
`http://127.0.0.1:8787`, the address `npm run dev` listens on, so nothing is needed while
developing locally. Point it at the deployed site to host a real game:

```bash
npm run host -- init myroom --soup soups/myroom.json --host https://<your-domain>
```

`SOUP_HOST` sets the same thing for a whole shell, which is the practical way to run a session
without repeating the flag on every call. `--host` wins when both are present.

```bash
export SOUP_HOST=https://<your-domain>       # bash
$env:SOUP_HOST = 'https://<your-domain>'     # PowerShell

npm run host -- wait myroom --soup soups/myroom.json
```

The scheme selects the transport: `https:` connects over `wss:`, anything else over `ws:`. The
value is sent as the `Origin` header, which the Worker checks against the request host
(`sameOrigin` in `worker/index.js`), so it must be the site's own origin — a mismatch is rejected
with `403 origin` rather than silently downgraded.

The soup file is `{ "surface": …, "bottom": …, "lives": 6 }` and lives in `soups/`, which is
gitignored. Only `surface` is ever published; the room document is readable by everyone in the
room, so the solution stays on the local disk until `reveal`.

Room content is untrusted input in both directions — a player can type instructions into a question
field. The defences are structural rather than prompt-based, so a fully hijacked model still cannot
leak the solution:

| Risk | Enforcement |
|---|---|
| Model coerced into revealing the solution | Answers are parsed against the `T`/`F`/`I` allow-list and must be non-empty; the leak budget is log₂3 bits per question, which is the game itself |
| Free-text note used as the leak channel | A note is accepted only on a row where the player asked for a hint, and is rejected if it shares a 6-character run with the local solution |
| Injection triggering the reveal | `reveal` is a separate operator command requiring the room name twice, and is kept out of the hosting loop |

Because the document is memory-only, a room that empties out loses the puzzle. Passing `--soup` to
`wait` and `answer` restores `surface` whenever the room comes back without it.

## Development

```bash
npm install
npm run setup:kv   # once: create the CTRL namespace and put its id in wrangler.toml
npm run dev        # run the Worker and Durable Objects locally
npm run deploy
npm run tail       # stream production logs
```

Deployment fails while the KV `id` in `wrangler.toml` is unset. This is deliberate: without KV the
administration commands cannot function. A namespace id is not a secret and is safe to commit —
using it still requires Cloudflare account authentication.

## Deployment

### Before deploying

- **Do not deploy while a game is in progress.** Because documents live in memory, `npm run deploy`
  restarts every Durable Object and therefore clears every active room. This is the practical cost
  of the in-memory design.
- If limits or the protocol change, `LIM` in `worker/validate.js` and the mirror at the top of
  `public/app.js` must be updated together.

### Free-plan allowances

Each allowance is metered independently: once one of them is exceeded, further operations of that
type fail until the daily reset. With no payment method on the account this **stops the service
rather than generating a bill**. All allowances reset at 00:00 UTC, which is 08:00 in Taipei — an
allowance exhausted during the evening stays exhausted until the following morning.

| Allowance | Effect once exceeded |
|---|---|
| Workers requests, 100k/day | The site stops responding; even the HTML fails to load |
| Durable Object requests 100k/day, duration 13,000 GB-s/day | Pages load but rooms are unreachable; after three failed attempts the client shows "連不上這個房間" |
| KV writes, 1,000/day | No user-visible effect; administration commands cannot be queued |
| SQLite rows written, 100k/day | No user-visible effect; `lock` cannot be written |

**Workers requests are the tightest of these.** Because `run_worker_first = true`, every request
invokes the Worker, including CSS, JavaScript, the font and the favicon — roughly 5 to 6 requests
per page view, which puts the practical ceiling at about **16,000 page views per day**. Ordinary
use stays well below that, but the allowance can be consumed by flooding the site with plain GET
requests, without joining a room or opening a WebSocket. **This is currently the cheapest denial
of service against the service.**

There is no alerting. An exhausted allowance produces no notification; it surfaces as users
reporting that the site is down. Use the Cloudflare dashboard metrics or `npm run tail` to check.

### Configuration notes

| Item | Notes |
|---|---|
| `run_worker_first = true` | Buys security headers on static responses at the cost of the request ceiling above. **Worth reconsidering:** room paths such as `/tonight` never match a file in `public/`, so the HTML is always served by the Worker regardless; disabling this only loses headers on sub-resources, where the one worth keeping (`nosniff`) can be supplied through `public/_headers`. Unverified: how completely Workers Assets supports `_headers`, and whether static-asset requests really are excluded from the 100k allowance |
| `html_handling = "none"` | **Do not change.** Any other value makes `/index.html` redirect to `/`, which in turn redirects to a new room name, producing a redirect loop |
| `not_found_handling = "none"` | Required if `run_worker_first` is disabled, so that unmatched paths still fall through to the Worker |
| `[[migrations]] new_sqlite_classes` | The free plan supports only SQLite-backed Durable Objects, so this cannot be removed. Renaming the `Room` or `Limiter` classes later **requires a `renamed_classes` migration**; renaming them directly orphans the existing objects. This is the easiest mistake to make in this file |
| `crons = ["* * * * *"]` | 1,440 Worker requests per day, about 1.4% of the free allowance. `*/5` reduces that at the cost of up to five minutes of administration latency |
| `compatibility_date` | Currently pinned to an older date. Moving it forward changes runtime behaviour by design, so **re-run the test suites after changing it** |
| `[observability]` | Logs have their own daily event allowance; set `head_sampling_rate` if volume becomes a concern |
| No `[[routes]]` | The Worker is published to `<name>.<subdomain>.workers.dev`. If a custom domain is added later, disable the workers.dev route so the service is not reachable at two hostnames |

### Dashboard settings

Rate limiting rules and Bot Fight Mode both operate at the edge, ahead of the Worker, so they can
absorb a GET flood before it consumes the Workers allowance.

Both are zone-level settings and therefore require a custom domain proxied through Cloudflare;
they are not expected to apply to a `*.workers.dev` hostname. **This has not been verified** —
confirm it before relying on either as a mitigation.

If a custom domain is in use:

- **Rate limiting rule**: cap requests per IP against the site root. This is the most direct
  defence against a GET flood.
- **Bot Fight Mode**: available on the free plan, but it is all-or-nothing and cannot be scoped by
  path. Verify that it does not interfere with the WebSocket upgrade, and that the challenge script
  it injects does not conflict with the strict CSP.

### GitHub Pages preview

The `index.html` in the repository root is a standalone preview served at
<https://cowrider2018.github.io/turtle-soup-page>. It embeds all of its own CSS and JavaScript and
contacts no backend, so it is single-player: the layout and interactions can be inspected, but
nothing synchronises and a reload discards everything.

- It is a **separate copy** from `public/`; changes to the application are not reflected in the
  preview. Either synchronise it by hand or treat it as a snapshot of an earlier design.
- It loads Google Fonts, whereas the application self-hosts its fonts.
- It carries no `noindex`. To keep it out of search results, add
  `<meta name="robots" content="noindex, nofollow">` to its `<head>`.
- Pages is served from the root of the `main` branch. `wrangler` does not bundle the repository
  root, so the two do not interfere.

## Administration

**There is no administration endpoint and no bespoke token.** Authentication is the Cloudflare
account itself (`wrangler login`), which keeps the number of publicly reachable routes at zero.

```bash
npm run soup -- lock <room>          # read-only: edits and clears are rejected, reads continue
npm run soup -- unlock <room>
npm run soup -- freeze               # stop writes site-wide and stop new rooms being created
npm run soup -- unfreeze
npm run soup -- flags

npm run soup -- status <room>        # peers, lock state, revision, size
npm run soup -- dump <room> [file]   # export the document (the room must have someone connected)
npm run soup -- wipe <room>
npm run soup -- delete <room> <room> # the room name must be given twice
```

Commands reach the Worker by two paths:

- `freeze` and `unfreeze` write the `frozen` key in KV directly. New connections and new rooms are
  affected immediately; rooms that are already open pick it up the next time they wake, which makes
  it the blunter of the two instruments.
- Everything else is appended to a `queue` key in KV, executed by the cron trigger once a minute,
  and the result is written back to `out:<id>`, which the CLI retrieves automatically. `lock` is
  dispatched straight to the room's own Durable Object and therefore **takes effect immediately**.
  The audit trail is in `wrangler tail`.

Nothing polls: lock state lives in each room's own Durable Object and is read once per instance,
so no repeated KV lookups are made while waiting for commands.

`status` and `dump` read live memory. If they arrive during the window in which an object has just
woken up, they report that a copy has been requested from the connected clients and ask you to
retry in a few seconds.

Add `--local` to operate against the local KV store used by `wrangler dev`.

**There is no room listing, and none will be added.** Durable Objects offer no enumeration API, and
maintaining an index would promote the account from "able to act on the room I name" to "able to
enumerate and act on every room", concentrating on a single key the isolation that unguessable room
names currently provide. Handling is reactive instead: a reported URL is acted on by name.

## Frontend

Appearance and behaviour match the original static page: no landing screen, no connection
indicator, no peer count, no administration controls, and only "全部清空" at the foot of the page.
The monospace face, Share Tech Mono, is self-hosted in `public/font/` under OFL-1.1 because the CSP
permits no third-party origins.

The one addition is error feedback. A locked room, an exceeded limit or a rejected change reuses
the dialog that already existed, at most once per minute per error type; without it a user would
keep typing into a room that is no longer accepting changes.

All administrative actions go through the CLI described above.

## Limits

Limits are defined by `LIM` in `worker/validate.js`. The copy at the top of `public/app.js` exists
only to avoid a round trip for input that would obviously be rejected; the two must be kept in step.
