// Minimal GetXAPI client — kept for future integrations, no research logic.
// Pay-per-call X API (~$0.001/call), bearer key only, no X dev account.
// Docs: https://docs.getxapi.com
//
// Key lookup: GETXAPI_KEY env -> ideascout data/config.json (getxapiKey).
//
// Usage:
//   node scripts/getxapi.mjs balance                      # free balance check
//   node scripts/getxapi.mjs search 'NQ levels lang:en'   # advanced search
//   node scripts/getxapi.mjs timeline some_handle    # a user's posts
//   node scripts/getxapi.mjs users 'NQ trader'            # people search
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "getxapi-cache");
const API = "https://api.getxapi.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ScalpingOps/0.1";
const IDEASCOUT_CONFIG = "/Users/amean/PROJECTS/DEV/Research/ideascout/data/config.json";

const state = { calls: 0, lastCallAt: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getKey() {
  if (process.env.GETXAPI_KEY) return process.env.GETXAPI_KEY;
  try {
    return JSON.parse(readFileSync(IDEASCOUT_CONFIG, "utf8")).getxapiKey ?? null;
  } catch {
    return null;
  }
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140);
}

async function xapiGet(path, params, { useCache = true, cacheTtlMs = 6 * 3600e3 } = {}) {
  const qs = new URLSearchParams(params);
  const url = `${API}${path}?${qs}`;
  const cacheFile = join(CACHE_DIR, sanitize(`${path} ${qs}`) + ".json");

  if (useCache && existsSync(cacheFile)) {
    const age = Date.now() - statSync(cacheFile).mtimeMs;
    if (age < cacheTtlMs) return JSON.parse(readFileSync(cacheFile, "utf8"));
  }

  const key = getKey();
  if (!key) throw new Error("No GetXAPI key (GETXAPI_KEY or ideascout config.json)");

  const wait = 1100 - (Date.now() - state.lastCallAt);
  if (wait > 0) await sleep(wait);

  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (res.status === 402) throw new Error("GetXAPI 402: credit exhausted — top up the account");
      if (res.status === 401) throw new Error("GetXAPI 401: bad/revoked API key");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      state.calls++;
      state.lastCallAt = Date.now();
      const data = JSON.parse(text);
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, text);
      return data;
    } catch (err) {
      lastErr = err;
      if (String(err.message).startsWith("GetXAPI 40")) throw err;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

export const accountInfo = () => xapiGet("/account/me", {}, { useCache: false });
export const searchTweets = (q, { product = "Latest", cursor } = {}) =>
  xapiGet("/twitter/tweet/advanced_search", { q, product, ...(cursor ? { cursor } : {}) });
export const userTweets = (userName, { cursor } = {}) =>
  xapiGet("/twitter/user/tweets", { userName, ...(cursor ? { cursor } : {}) });
export const searchUsers = (q, { cursor } = {}) =>
  xapiGet("/twitter/user/search", { q, ...(cursor ? { cursor } : {}) });

// ---- tiny CLI for one-off checks ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "balance") console.log(JSON.stringify(await accountInfo(), null, 2));
    else if (cmd === "search") {
      const j = await searchTweets(rest.join(" "));
      console.log(`${j.tweet_count ?? 0} tweets (has_more=${j.has_more})`);
      for (const t of j.tweets ?? []) console.log(`- @${t.author?.userName} [${t.likeCount}♥] ${(t.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    } else if (cmd === "timeline") {
      const j = await userTweets(rest[0]);
      console.log(`${j.tweet_count ?? 0} tweets for @${rest[0]}`);
      for (const t of j.tweets ?? []) console.log(`- ${t.createdAt} ${(t.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
    } else if (cmd === "users") {
      const j = await searchUsers(rest.join(" "));
      for (const u of j.users ?? []) console.log(`- @${u.userName} (${u.followers} fol) ${(u.description ?? "").slice(0, 80)}`);
    } else {
      console.log("usage: node scripts/getxapi.mjs <balance|search <q>|timeline <handle>|users <q>>");
      process.exit(1);
    }
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}
