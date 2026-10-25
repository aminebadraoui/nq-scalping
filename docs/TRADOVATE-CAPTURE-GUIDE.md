# Tradovate Token Capture Guide — iOS app session → computer

Goal: get the access token (and the exact md request frames) the Tradovate
iOS app uses, so the collector (`web/scripts/tradovateMd.ts`) can replay the
same market-data session on the computer. Background and endpoint facts live
in `TRADOVATE-MARKET-DATA-RESEARCH.md`.

Google-SSO accounts have **no Tradovate password** — there are no
long-lived credentials to extract. What you capture is the session access
token Tradovate issues after the Google handshake (~90 min lifetime). The
collector renews it automatically and persists the newest token to
`web/.tradovate-md-token.json`, so a single capture can stay alive
indefinitely; when the chain finally breaks, re-capture and set
`TVMD_TOKEN` again.

---

## Password mode (preferred): no Google in the chain

A Tradovate account with a real username/password (a new non-SSO
account, or an SSO account with a password added via Web Trader →
Settings → Profile → Change Username) removes the fragile Google
session entirely. Set both on the VPS (Coolify secrets — never commit):

```env
TVMD_USERNAME=<tradovate username>
TVMD_PASSWORD=<tradovate password>
```

With both set, `tvmdRecapture.ts` skips the cookie import and the
Google click: it opens trader.tradovate.com in headless Chromium, types
the credentials into the platform's own login form (the page performs
its own request signing, so web-build changes don't break us), and
captures the authorize-frame JWT as before. Same probe, same 12h
re-anchor, same backoff. A rejected password or a verification-code /
captcha prompt fails fast and pages Telegram — it never retries
credentials in a loop (that earns penalty tickets). The persistent
profile keeps one stable deviceId, so re-logins don't burn device quota.

Test locally first (`TVMD_CHROMIUM` points at Mac Chrome; a scratch
profile keeps it off your real one):

```bash
cd web
TVMD_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  TVMD_RECAP_PROFILE=/tmp/tvmd-profile \
  TVMD_ENV=demo TVMD_USERNAME=... TVMD_PASSWORD=... \
  TVMD_TOKEN_FILE=./data/.tradovate-md-token.json \
  node --import ../scripts/ts-loader.mjs ./scripts/tvmdRecapture.ts
```

---

## Autoheal: capture the Google SSO once, then it heals itself (VPS)

The VPS runs a self-healing loop (`web/scripts/tvmdRecapture.ts`, every
60s from `docker-entrypoint.sh`). The architecture, and the two failure
modes it exists for:

1. **The token chain has a hard cap.** `auth/renewaccesstoken` extends a
   demo SSO session ~30 min at a time, but a session hits a hard
   lifetime ceiling (~24h from the Google-SSO login) that renewals cannot
   extend past — the collector then gets "Expired Access Token" minutes
   after a successful renewal. The loop therefore RE-ANCHORS
   proactively: whenever the token file's `anchoredAt` (the last fresh
   login) is older than `TVMD_RECAP_ANCHOR_HOURS` (default 12h), it
   launches the browser and mints a fresh session even if the token
   still answers.
2. **The Google session is the fragile asset.** A Google login completed
   from the VPS datacenter IP in headless chromium gets re-verification
   challenges and dies fast. The durable "capture once" is exporting the
   cookies from YOUR real Mac Chrome (trusted device, residential IP,
   2FA done) and shipping them to the VPS profile.

**One-time capture (preferred — do this once):**

```bash
# on the Mac: quit Chrome, relaunch it once with the debug flag
open -a "Google Chrome" --args --remote-debugging-port=9333
# make sure that Chrome is signed in to Google AND logged into trader.tradovate.com
cd web
node --import ../scripts/ts-loader.mjs ./scripts/tvmdCookieExport.ts --ship
```

`--ship` copies the session cookies into the running nq-dashboard
container (`/app/data/tvmd-google-session.json`, never committed,
mode 600). The recapture loop imports them into its persistent browser
profile before every harvest, so the "Sign in with Google" click-through
completes silently — no prompts, forever.

**Fallback capture (one-time login via the dashboard):** `/tvmd` →
Browser login → open the printed `http://…:9222` URL (SSH-tunneled) →
complete the Google sign-in once. The profile persists it on the volume.

**The heal loop then runs unattended:**

- every 60s it probes the token against the same engine the collector
  uses (`TVMD_ENV`-consistent REST host — a mismatch here was a past
  bug: probing demo with a live token spins the loop forever);
- a dead/stale token launches headless Chromium (stale `Singleton*`
  profile locks from container rebuilds are cleared first — they used to
  kill every launch with "profile in use, exit 21" after each redeploy),
  clicks through the Google SSO with real input events when the login
  screen appears, captures the authorize-frame JWT, and writes it to
  `TVMD_TOKEN_FILE` with `anchoredAt` — the collector hot-swaps ~10s;
- consecutive failures back off (5m → 15m → 30m: hammering Google with
  repeated datacenter logins is what gets sessions killed), persist
  `.recap-status.json`, and page you on **Telegram** when the Google
  session itself is dead — the one thing automation cannot heal.
  The `/tvmd` session bar shows the loop's health chip
  (`autoheal ● ready` / `google session ✗ — needs re-login`).

**Troubleshooting the loop:**

| Symptom | Cause / fix |
|---|---|
| `chromium exited early (code 21)` in the VPS log | stale `Singleton*` files in `/app/data/tvmd-browser-profile` — the current script clears them; on old images delete them once by hand |
| `no token captured — the stored Google session did not complete the sign-in` | Google session dead: re-run `tvmdCookieExport.ts --ship` (or the dashboard Browser login) |
| loop launches chromium every minute | env mismatch: `TVMD_REST_HOST`/`TVMD_ENV` must match the collector's; also fixed by the current script's derived default |
| "Expired Access Token" minutes after a renewal | the session hit its hard cap — normal; the proactive 12h re-anchor prevents it; one harvest heals it |

---

## Route A — Chrome DevTools on the web platform (recommended, ~5 min)

The web platform is the same account on the same servers; its traffic is
identical and visible without any proxy.

1. On the Mac: Chrome → <https://trader.tradovate.com> → **Sign in with
   Google** — the same Google account as the iOS app.
   (Known quirk: desktop Google sign-in occasionally loops/fails —
   [PickMyTrade](https://pickmytrade.trade/debugging/google-signin-fails-desktop-app/).
   If so, try another browser or Route B.)
2. Open a chart / DOM widget for the contract you care about — the
   market-data WebSocket only appears once the UI subscribes to something.
3. **Open DevTools first, then reload.** DevTools only records WebSocket
   connections made *after* it is open — the page opens its sockets at
   login, so: ⌘⌥I → **Network** tab → clear the filter box (don't use the
   `WS` chip yet — search `tradovateapi` instead) → ⌘R to reload with
   DevTools running → click around to open a chart/DOM widget.
4. In the Network list you should now see WS entries. **Trial accounts
   typically live on the DEMO environment** — the trading socket is
   `demo.tradovateapi.com` and the market-data socket is
   `md-demo.tradovateapi.com` (live accounts use `live.`/`md.` hosts
   instead). Any `tradovateapi.com` entry is fine. Click the **md** one →
   **Messages** tab. (If no md socket appears even with a chart open, see
   *Fallbacks* below — the token is on the trading socket too.)
5. The first outbound message is the **authorize** frame, raw text shaped
   like:
   ```
   authorize
   0

   "eyJh...<the token>...zQ"
   ```
   Copy the token — the quoted string after the last newline.
6. Scroll the outbound frames to see the app's `md/subscribequote` /
   `md/subscribedom` / `md/subscribehistogram` / `md/getchart` requests and
   note the exact symbols it uses (e.g. `NQM7`) — set `TVMD_SYMBOLS` to match.
7. Save to `web/.env.local` (gitignored):
   ```env
   TVMD_TOKEN=<copied token>
   TVMD_SYMBOLS=NQM7
   TVMD_ENV=demo       # trial accounts are on the demo environment; live accounts use live
   ```
8. Run the collector — see *Running the collector* below.

### Fallbacks if you can't find the md socket

- **The trading socket carries the token too.** The `live.tradovateapi.com`
  (or `demo.tradovateapi.com`) WS connection appears immediately at login.
  Click it → Messages → search the frames for `"accessToken"` — the login
  response contains the same token the md socket authorizes with. Copy it
  from there.
- **Local storage.** Application → Local Storage → the platform origin →
  look for a key containing `token` or `access` — the session token is
  persisted there (key name varies by build).
- **Log every WS URL *and* capture the token from the console.** If the
  Network tab is being difficult, paste this in the Console, then reload
  (it hooks all WebSocket URLs, every outbound frame, token-bearing
  inbound frames, and auth REST responses):
  ```js
  const OrigWS = window.WebSocket;
  const origSend = OrigWS.prototype.send;
  OrigWS.prototype.send = function (data) {
    const s = String(data);
    if (s.length < 600 && s.trim() !== "[]") console.log("WS-SEND →", s.slice(0, 300));
    return origSend.apply(this, arguments);
  };
  window.WebSocket = function (...args) {
    console.log("WS-URL:", args[0]);
    const ws = new OrigWS(...args);
    ws.addEventListener("message", (ev) => {
      const s = String(ev.data);
      if (/accessToken|"token"/.test(s)) console.log("WS-RECV →", s.slice(0, 500));
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(window.WebSocket, OrigWS);
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(async (res) => {
      if (/auth|token|login|oauth/i.test(String(args[0]))) {
        const text = await res.clone().text();
        console.log("FETCH-AUTH →", String(args[0]), text.slice(0, 500));
      }
      return res;
    });
  };
  ```
  After reload, the token appears in the console as the outbound
  `WS-SEND → authorize\n0\n\n"…"` frame, and/or in `WS-RECV`/`FETCH-AUTH`
  lines containing `accessToken`. Paste once per page load (reloading
  clears the hooks).
- **Delayed/orange data?** The md socket still opens when you open a
  chart/DOM widget — the delay is entitlement-side, not connection-side.

**Tip:** a `shutdown`/`c` frame or a 401 in DevTools means the token died;
re-capture the same way. The token also lives in the browser's local
storage for that origin, but the authorize frame is the authoritative place
to read it.

## Route B — MITM the phone (what you originally asked)

Same result, but with proxy + cert setup and a pinning risk.

1. `brew install mitmproxy` → run `mitmproxy` (or `mitmweb` for a browser UI).
2. Get the Mac's LAN IP: `ipconfig getifaddr en0`.
3. iPhone → Settings → Wi-Fi → your network → ⓘ → Configure Proxy → **Manual**
   → server = Mac IP, port = **8080**.
4. On the iPhone, Safari → `http://mitm.it` → install the mitmproxy profile →
   Settings → General → **VPN & Device Management** → install → then
   Settings → General → About → **Certificate Trust Settings** → enable
   full trust for the mitmproxy CA.
5. Launch Tradovate → in mitmproxy, filter `tradovateapi.com` → open the
   WebSocket flow → view messages → copy the token from the `authorize`
   frame, and note the symbols in the md subscribe frames.
6. **TLS pinning check:** if the app errors out or refuses to connect with
   the proxy on (but works with it off), it pins its certificate and Route B
   is a dead end without a jailbroken device → use Route A.
7. Turn the proxy off when done (and untrust/remove the CA profile if you
   want to be tidy).

## Running the collector — direct mode (primary)

```bash
cd web
node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts
```

This connects straight from Node to `wss://md-demo.tradovateapi.com/v1/websocket`
(`TVMD_ENV=demo`) and works with Google-SSO session tokens. The two
requirements discovered the hard way:

1. **The SSO JWT must be sent RAW (unquoted) in the authorize frame.**
   The classic SDK JSON-stringifies the token body; the SSO parser rejects
   the quoted form with `401 "Access is denied"` and accepts the bare
   string. The collector does this automatically.
2. **Renewal lives on the trading socket** (`wss://demo.tradovateapi.com`):
   `auth/renewaccesstoken` returns a fresh token (`d.accessToken`); the
   demo environment grants ~30-min extensions, so the collector renews
   every 20 min and persists the newest token to
   `web/.tradovate-md-token.json`. The md socket 404s that endpoint.

Expected flow: `authorized ok` → one `ok:` line per subscription with
`"mode":"RealTime"` → 10s summaries of live pushes. All frames go to
`web/data/tradovate-md/md-<YYYY-MM-DD>.jsonl` (ET day). Ctrl-C stops.

**Token finally dead (session dropped through expiry)?** On the VPS the
autoheal loop (above) handles this automatically — paste only when the
loop is disabled or the collector runs on the Mac. Re-capture via
Route A (the platform page's authorize frame — reload the page to mint a
fresh one), then paste the new JWT into the **session bar on `/tvmd`** and
hit Apply. The API persists it to the shared token file and the collector
hot-restarts with it within ~10s — no env edits, no redeploy, works the
same on the VPS (volume) and the Mac. `TVMD_TOKEN` env is bootstrap-only:
after the first renewal the volume file wins.

**New demo account?** Same flow, one paste: capture the new account's JWT
from its authorize frame and paste it in the `/tvmd` session bar.
Everything else (hosts, env, symbols) is unchanged — and a fresh account
restarts the 2-week real-time trial window.

## Browser relay mode (fallback)

If a server update ever starts rejecting direct Node connections again,
run the sink + in-page relay instead:

1. Terminal 1: `TVMD_TRANSPORT=http node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts`
2. Terminal 2: `node --import ../scripts/ts-loader.mjs ./scripts/tradovateMdSnippet.ts`
3. Paste the printed block into the DevTools console of the logged-in
   trader.tradovate.com page and keep the tab open.

The page opens the md socket (browser context), subscribes, renews in-page,
and relays every frame to the sink, which owns the same JSONL journal.

## Expectations & guardrails

- **Entitlements are server-side.** The 2-week trial streams real-time
  futures data; after the trial, a non-funded sim login drops to ~10-min
  delayed. Replaying the app's session changes nothing about that.
  (`TRADOVATE-MARKET-DATA-RESEARCH.md` §1)
- **Quotas:** 15 market-data devices / 5 IPs per user — the phone and this
  client each count as a device; don't run many copies.
- **Personal use only.** Storing your own account's data for your own
  research is fine; sharing/redistributing the feed or derived data is not
  (CME non-pro terms — research doc §6).
- **Unofficial client caveat:** Tradovate's official API add-on ($25/mo,
  live-funded accounts only) is the sanctioned way to run your own client;
  this capture-and-replay is a research shortcut on your own account — use
  it accordingly.
- The token file and data dir are gitignored; never commit credentials.
