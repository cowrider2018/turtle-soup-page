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
  - `Limiter`: caps, per hashed client IP, room creation (10 per hour, 60 per day) and puzzles
    handed to the AI host (3 per hour, 10 per day).
- AI host: `worker/judge.js`, the only code that calls a model, through the Workers AI binding
  and on the free allowance only. See [AI host](#ai-host).
- The server is the only writer. Every message from a client is treated as untrusted input and
  validated in `worker/validate.js`.

### Documents live in memory only

Rooms in a party tool are short-lived by nature, and high-frequency collaborative editing would
consume a large share of the daily storage-write allowance if every change were persisted. The
document is therefore **never written to storage** and exists only in the Durable Object's memory.
The one exception is a puzzle handed to the AI host, whose solution cannot live in the document
(see [Storage](#storage)).

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
| Rate limiting | 5 ops/s per connection (burst 20), 32 concurrent peers per room, room creation and AI puzzles capped per IP |
| Containment | None short of stopping the Worker from the dashboard; there is no per-room lock or site-wide freeze |
| Data minimisation | Documents are never persisted and disappear once everyone leaves; a hosted puzzle is kept until the room is wiped or has been empty for seven days; IPs are used only in hashed form for rate limiting and are not retained |
| No value as a spam host | `noindex` plus plain-text rendering (no hyperlinks) removes the SEO incentive |

**Explicitly out of scope, and accepted:** content is not confidential — everyone in the room can
read the document, and a hosted solution is hidden from the page, not from whoever pasted it;
there are no accounts, so actions cannot be attributed; a short, self-chosen room name is
effectively public and can be guessed (use a generated random name if isolation matters); and
**vandalism cannot be rolled back** — there are no snapshots, no containment short of stopping the
Worker, and recovery means moving to a new room name.

## AI host

A room can be handed to an AI host from the page itself. Nothing runs locally and there is no
operator step: hosting starts, pauses and ends with buttons at the foot of the page.

- **呼叫 AI 主持** opens a dialog for the surface and the solution, prefilled with whatever the room
  already shows so that a game hosted by a person can be handed over mid-way. Both travel to the
  server in a single `host` message. The surface is written into the room; the solution goes into
  the room's Durable Object storage and **never enters the document**, because the document is
  readable by everyone and mirrored into every browser.
- While the AI is present (`ear`), every question a player commits is judged once, in row order,
  by `worker/judge.js`, and answered with `T` / `F` / `I`. There are no hints. The only note the
  host ever writes is a fixed "判不出來，換個問法再問一次" when the model returns nothing usable;
  rephrasing the question retries it.
- **請離 AI** stops judging (`away`) and keeps the solution hidden. **請回 AI** resumes the same
  puzzle without pasting it again. While the AI is away the answer and note columns belong to
  people again: whoever pasted the puzzle knows the solution and can carry on by hand.
- **揭曉湯底** writes `want`. The server answers by writing the stored solution into the room, and
  the AI leaves, since there is nothing left to judge.
- **全部清空** ends the game and discards the stored puzzle.

Presence (`here`) is derived from the stored puzzle rather than from the document, so a client
cannot claim that a host is present by seeding a document of its own.

### Calling and dismissing reliably

Sending is not delivering. A connection that looks open may already be dead (a laptop lid, a phone
changing networks), and the object may restart halfway through. So each press of 呼叫 / 請離
carries an action ID. Until the server sends back an `ack` for that ID, or an error carrying it,
the page disables both that button and 全部清空, labelled 呼叫中… / 請離中…; without an answer it
resends with the same ID every six seconds, three times, then says the host is not responding.
The pasted puzzle is kept in memory meanwhile, never in `sessionStorage`, so trying again needs no
second paste.

The server keeps the last eight action IDs, in memory and on the stored puzzle, and answers a
repeat with the current state instead of acting twice. Remembering only the last one is not
enough: a call followed by a dismissal would forget the call, and a late resend of it would bring
the AI back. The ID is client-written and so only prevents doing a thing twice; it never waives a
limit. A second call within one call–dismiss cycle simply has no effect, and a new puzzle goes
through the per-IP limit however the ID is set.

A call that arrives while the object is waiting for a seed is not dropped. Pasting takes long
enough for an idle room to hibernate, so the call is usually the very message that wakes it; it
once vanished there, which looked like a button that did nothing. The puzzle is stored at once
and projected onto the document when the seed arrives, or by the heal that runs if none does.

### What the server enforces

Room content is untrusted input in both directions — a player can type instructions into a
question. The defences are structural, so a fully hijacked model still cannot leak the solution:

| Risk | Enforcement |
|---|---|
| Model coerced into revealing the solution | The reply is parsed against the `T`/`F`/`I` allow-list and nothing else the model writes reaches the room. The leak budget is log₂3 bits per question, which is the game itself |
| A player writes the solution or the answers | While a puzzle is hidden, `surface`, `bottom` and `ask` are server-only; while the AI is present, so is every row's `a` and `n`. Blocked operations are dropped and answered with `hosted`; the rest of the batch is kept, so a question sent alongside is not lost |
| A seed replaces the puzzle | A seeded document has its `surface` and `bottom` overwritten from storage before it is accepted |
| The solution in logs | Only the row number, answer, latency and neurons are logged; never a question or the solution |
| Strangers burning the day's AI allowance | Pasting a new puzzle is limited per hashed IP (3 per hour, 10 per day); resuming does not count. A puzzle is judged at most 200 times. The account has no payment method, so exhausting the free allowance fails closed. **There is no site-wide budget**: many addresses together can still use up the day |

### The model

`@cf/qwen/qwen3-30b-a3b-fp8`, with `/think` appended to the prompt, JSON-schema output, temperature
0, at most 1,536 output tokens and a 60-second timeout.

Measured on 2026-09-23 against one invented puzzle and twelve questions:

| Setting | Correct | Neurons per question |
|---|---|---|
| `qwen3-30b-a3b-fp8` + `/think` (in use) | 11/12 | ~10, which is roughly 1,000 questions a day |
| `qwen3.8-27b`, `reasoning_effort: low` | 12/12 | ~38 |
| `qwen3.8-27b`, `reasoning_effort: medium` | — | ~191 on a single probe; not pursued |

Twelve questions is not an accuracy guarantee, and the same setting has been seen to answer one
question differently across runs even at temperature 0. The trade-off between the two models is
deliberately deferred: it is one constant in `worker/judge.js`. One question made every reasoning
model think for 1,600 to 2,900 tokens, which is why the output cap exists.

Jev (`typesafe/jev`) was evaluated and rejected. It is billed in AI Gateway credits rather than the
free allowance, and a free account receives `2021: Insufficient AI Gateway credits`.

A pasted puzzle is capped at 800 characters of surface and 1,500 of solution, narrower than the
room's own fields, so that one message stays within the 8 KB limit even in CJK text. Shorter is
also cheaper: the solution is sent to the model with every question.

### Storage

A hosted room persists one `soup` key: surface, solution, whether the AI is present, whether the
solution has been revealed, how many questions have been judged, and the recent action IDs. It is
written when hosting starts, pauses or ends, and once per judged question. Because of it, a hosted room survives the
object being evicted: the surface comes back from storage, although rows that no browser still
holds do not. An alarm removes the key once the room has been empty for seven days.

## Development

```bash
npm install
npm run dev        # run the Worker and Durable Objects locally
npm run deploy
npm run tail       # stream production logs
```

The AI binding always reaches the real Workers AI service, even under `npm run dev`, so hosting a
game locally spends the same daily allowance as production.

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
| SQLite rows written, 100k/day | The AI host cannot start, pause or record a judged question |
| Workers AI, 10,000 neurons/day | The AI host stops answering and leaves the room; the page says the day's allowance is used up. At about 10 neurons per question this is roughly 1,000 questions a day across the whole site |

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
| `[ai]` | The Workers AI binding used by `worker/judge.js`. Keep to models that draw on the free allowance; models marked as requiring paid billing fail on this account, and Jev needs AI Gateway credits |
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

## Operations

**There is no administration endpoint, no bespoke token and no administration CLI.** Everything a
game needs happens on the page. What is left for the account owner happens in the Cloudflare
dashboard:

- **Emergency stop:** disable the Worker's `workers.dev` route, or roll back or delete the
  deployment. There is no per-room lock and no site-wide freeze any more; stopping the Worker is
  the only containment.
- **Checking usage:** the Workers and Workers AI metrics pages, or `npm run tail`.

**There is no room listing, and none will be added.** Durable Objects offer no enumeration API, and
maintaining an index would promote the account from "able to act on the room I name" to "able to
enumerate and act on every room", concentrating on a single key the isolation that unguessable room
names currently provide.

## Frontend

Appearance and behaviour match the original static page: no landing screen, no connection
indicator, no peer count and no administration controls. The foot of the page carries "全部清空"
plus the AI host's two buttons: one that reads 呼叫 AI 主持 / 請離 AI / 請回 AI depending on the
host's state, and 揭曉湯底 while a solution is hidden. While the AI is present the answer picker
and the note field are disabled, and the surface and solution fields are read-only for as long as
a solution is hidden.
The monospace face, Share Tech Mono, is self-hosted in `public/font/` under OFL-1.1 because the CSP
permits no third-party origins.

Error feedback reuses the dialog that already existed: an exceeded limit, a rejected change or an
exhausted AI allowance is reported at most once per minute per error type. The one silent case is
`hosted`: the client drops the blocked fields from its resend queue and asks for a fresh copy,
because resending them would loop against the server.

## Limits

Limits are defined by `LIM` in `worker/validate.js`. The copy at the top of `public/app.js` exists
only to avoid a round trip for input that would obviously be rejected; the two must be kept in step.
