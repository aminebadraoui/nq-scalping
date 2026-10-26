/* ------------------------------------------------------------------ *
 * Tradovate in-browser market-data relay (plain browser JS).
 *
 * Why this exists: Tradovate's demo/live servers reject market-data
 * WebSocket connections that don't come from the logged-in web
 * platform's own browser context (foreign clients get 401 "Access is
 * denied" even with a valid SSO JWT). This script runs INSIDE the
 * trader.tradovate.com page — the browser opens the md WebSocket, so
 * the connection is indistinguishable from the platform's own — and
 * relays every frame to the local sink (scripts/tradovateMd.ts with
 * TVMD_TRANSPORT=http), which owns the JSONL journal, stats, and token
 * persistence.
 *
 * Do not run this file directly. Run scripts/tradovateMdSnippet.ts to
 * generate a paste-ready snippet (token/symbols/hosts inlined), then
 * paste it into the DevTools console of the logged-in platform page.
 * Keep the tab open — closing it stops the stream (the sink keeps
 * running and the snippet is one re-paste away).
 * ------------------------------------------------------------------ */

(function () {
  "use strict";
  if (window.__tvmdRunning) {
    console.log("[tvmd] already running in this page");
    return;
  }
  window.__tvmdRunning = true;

  var CFG = {
    token: __TVMD_TOKEN__,
    symbols: __TVMD_SYMBOLS__,
    mdHost: "__TVMD_MD_HOST__",
    tradeHost: "__TVMD_TRADE_HOST__",
    subs: __TVMD_SUBS__,
    chartElements: __TVMD_CHART_ELEMENTS__,
    sink: "__TVMD_SINK__",
    renewEveryMs: 20 * 60 * 1000,
  };

  // If no token was inlined, try to find a JWT-shaped value the
  // platform stashed in localStorage (survives re-pastes).
  if (!CFG.token) {
    try {
      for (var li = 0; li < localStorage.length; li++) {
        var lk = localStorage.key(li);
        var lv = lk ? localStorage.getItem(lk) : null;
        if (lv && /^eyJ[^.]+\.eyJ[^.]+\./.test(lv) && lv.length > 100 && lv.length < 8000) {
          CFG.token = lv;
          break;
        }
      }
    } catch (e) {
      /* private mode etc. */
    }
  }
  if (!CFG.token) {
    console.error("[tvmd] no token available — regenerate the snippet (scripts/tradovateMdSnippet.ts) after re-capturing");
    return;
  }

  var sock = null;
  var reqId = 0;
  var backoffMs = 3000;
  var lastFrameAt = 0;
  var authFails = 0;
  var didInitialRenew = false;
  var pending = new Map();

  function post(path, payload) {
    try {
      fetch(CFG.sink + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } catch (e) {
      /* sink down — console only */
    }
  }

  function log(msg) {
    console.log("[tvmd] " + msg);
    post("/status", { level: "info", msg: msg });
  }
  function logErr(msg) {
    console.error("[tvmd] " + msg);
    post("/status", { level: "error", msg: msg });
  }

  function send(endpoint, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!sock || sock.readyState !== 1) {
        reject(new Error("no socket"));
        return;
      }
      var id = ++reqId;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("timeout waiting for " + endpoint));
      }, timeoutMs || 20000);
      pending.set(id, function (item) {
        clearTimeout(timer);
        resolve(item);
      });
      var frame = endpoint + "\n" + id + "\n\n" + JSON.stringify(body);
      try {
        sock.send(frame);
        post("/frame", { dir: "out", frame: frame });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  // SSO JWTs must be sent RAW (unquoted) — the platform's own frames
  // carry the bare token; the JSON-quoted form gets 401 "Access is denied".
  function sendRaw(endpoint, rawBody, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!sock || sock.readyState !== 1) {
        reject(new Error("no socket"));
        return;
      }
      var id = ++reqId;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("timeout waiting for " + endpoint));
      }, timeoutMs || 20000);
      pending.set(id, function (item) {
        clearTimeout(timer);
        resolve(item);
      });
      var frame = endpoint + "\n" + id + "\n\n" + rawBody;
      try {
        sock.send(frame);
        post("/frame", { dir: "out", frame: frame });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  function subscribeOne(endpoint, body, label) {
    return send(endpoint, body)
      .then(function (item) {
        if (item.s === 200) {
          log(label + " ok " + JSON.stringify(item.d));
          return;
        }
        var d = item.d || {};
        if (d["p-ticket"] !== undefined || d["p-time"] !== undefined) {
          if (d["p-captcha"]) {
            logErr(label + ": captcha penalty — cannot retry; stop and restart later");
            return;
          }
          var waitMs = (Number(d["p-time"]) || 0) * 1000;
          log(label + ": penalty — retrying in " + waitMs / 1000 + "s");
          setTimeout(function () {
            var retry = Object.assign({}, body, { "p-ticket": d["p-ticket"] });
            subscribeOne(endpoint, retry, label);
          }, waitMs);
          return;
        }
        logErr(label + " failed: " + JSON.stringify(d));
      })
      .catch(function (e) {
        logErr(label + " error: " + e.message);
      });
  }

  function subscribeAll() {
    CFG.symbols.forEach(function (sym) {
      if (CFG.subs.quote) subscribeOne("md/subscribequote", { symbol: sym }, "quote " + sym);
      if (CFG.subs.hist) subscribeOne("md/subscribehistogram", { symbol: sym }, "hist " + sym);
      if (CFG.subs.chart) {
        subscribeOne(
          "md/getchart",
          {
            symbol: sym,
            chartDescription: {
              underlyingType: "Tick",
              elementSize: 1,
              elementSizeUnit: "UnderlyingUnits",
              withHistogram: false,
            },
            timeRange: { asMuchAsElements: CFG.chartElements },
          },
          "tick " + sym,
        );
      }
    });
  }

  function authorize() {
    if (!sock || sock.readyState !== 1) return;
    sendRaw("authorize", CFG.token, 25000)
      .then(function (item) {
        if (item.s === 200) {
          authFails = 0;
          backoffMs = 3000;
          log("authorized ok — subscribing");
          subscribeAll();
          // beat a near-expiry token: renew right away instead of
          // waiting for the 45-min cycle
          if (!didInitialRenew) {
            didInitialRenew = true;
            renew();
          }
          return;
        }
        authFails += 1;
        var why = item.d && item.d.errorText ? item.d.errorText : JSON.stringify(item.d);
        logErr("authorize failed: " + why + " (attempt " + authFails + ")");
        if (authFails >= 3) {
          logErr("giving up reconnects — re-capture a token, regenerate the snippet, re-paste");
          return;
        }
        setTimeout(function () {
          if (sock && sock.readyState === 1) authorize();
        }, 60000);
      })
      .catch(function (e) {
        logErr("authorize error: " + e.message);
      });
  }

  function connect() {
    if (sock) return;
    try {
      sock = new WebSocket(CFG.mdHost + "?r=" + Math.random().toString(16).slice(2));
    } catch (e) {
      logErr("connect failed: " + String(e));
      setTimeout(connect, backoffMs);
      return;
    }
    sock.onopen = function () {
      lastFrameAt = Date.now();
      log("md socket open — waiting for 'o'");
    };
    sock.onmessage = function (ev) {
      lastFrameAt = Date.now();
      var s = String(ev.data);
      post("/frame", { dir: "in", frame: s });
      var t = s[0];
      if (t === "o") {
        authorize();
        return;
      }
      if (t === "h") {
        try {
          sock.send("[]");
        } catch (e) {}
        return;
      }
      if (t === "a") {
        var arr;
        try {
          arr = JSON.parse(s.slice(1));
        } catch (e) {
          return;
        }
        if (!Array.isArray(arr)) arr = [arr];
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          if (item.i && pending.has(item.i)) {
            var cb = pending.get(item.i);
            pending.delete(item.i);
            cb(item);
          }
        }
        return;
      }
      if (t === "c") {
        log("server close frame: " + s.slice(0, 200));
      }
    };
    sock.onclose = function () {
      sock = null;
      pending.clear();
      var wait = backoffMs;
      backoffMs = Math.min(60000, backoffMs * 2);
      log("md socket closed — reconnecting in " + Math.round(wait / 1000) + "s");
      setTimeout(connect, wait);
    };
    sock.onerror = function () {
      /* onclose follows */
    };
  }

  function renew() {
    var old = CFG.token;
    var w;
    try {
      w = new WebSocket(CFG.tradeHost + "?r=" + Math.random().toString(16).slice(2));
    } catch (e) {
      logErr("renew: cannot open trading socket: " + String(e));
      return;
    }
    var id = 0;
    var done = false;
    var finish = function (next) {
      if (done) return;
      done = true;
      try {
        w.close();
      } catch (e) {}
      if (next) {
        CFG.token = next;
        post("/token", { token: next });
        log("token renewed and handed to the sink");
      } else {
        log("renew failed — retrying next cycle; re-capture if the session drops");
      }
    };
    var timer = setTimeout(function () {
      finish(null);
    }, 20000);
    w.onmessage = function (ev) {
      var s = String(ev.data);
      var t = s[0];
      if (t === "o") {
        w.send("authorize\n" + ++id + "\n\n" + old); // SSO JWT: raw, unquoted
      } else if (t === "h") {
        w.send("[]");
      } else if (t === "a") {
        var arr;
        try {
          arr = JSON.parse(s.slice(1));
        } catch (e) {
          return;
        }
        if (!Array.isArray(arr)) arr = [arr];
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          if (item.i === 1 && item.s === 200) {
            w.send("auth/renewaccesstoken\n" + ++id + "\n\n" + JSON.stringify({ token: old }));
          } else if (item.i === 2) {
            clearTimeout(timer);
            var d = item.d;
            var next = null;
            if (item.s === 200) {
              if (typeof d === "string") next = d;
              else if (d && typeof d.accessToken === "string") next = d.accessToken;
              else if (d && typeof d.token === "string") next = d.token;
            }
            finish(next);
          } else if (item.i === 1 && item.s !== 200) {
            clearTimeout(timer);
            finish(null);
          }
        }
      }
    };
    w.onerror = function () {
      clearTimeout(timer);
      finish(null);
    };
    w.onclose = function () {
      clearTimeout(timer);
      finish(null);
    };
  }

  setInterval(function () {
    if (sock && sock.readyState === 1 && Date.now() - lastFrameAt >= 2500) {
      try {
        sock.send("[]");
      } catch (e) {}
    }
  }, 2500);
  setInterval(renew, CFG.renewEveryMs);

  connect();
})();
