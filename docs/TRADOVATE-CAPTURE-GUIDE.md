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

**Token finally dead (session dropped through expiry)?** Re-capture via
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
