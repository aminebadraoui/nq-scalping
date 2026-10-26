"use client";

/* Client-side companion to lib/adminAuth.ts: fetch() for the dashboard's
 * admin-only write endpoints. Asks for the ADMIN_PASSWORD once per tab
 * (sessionStorage — gone when the tab closes), sends it as
 * `x-admin-password`, and re-asks once on a 401 (wrong / rotated). */

const KEY = "nq-admin-password";

function stored(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function ask(message: string): string {
  const pw = (window.prompt(message) ?? "").trim();
  try {
    if (pw) sessionStorage.setItem(KEY, pw);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked — the password lives for this call only */
  }
  return pw;
}

export async function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (pw: string) => {
    const headers = new Headers(init.headers);
    headers.set("x-admin-password", pw);
    return fetch(input, { ...init, headers });
  };
  let pw = stored() || ask("Admin password");
  if (!pw) return Response.json({ ok: false, reason: "admin password required" }, { status: 401 });
  let res = await send(pw);
  if (res.status === 401) {
    pw = ask("Wrong admin password — try again");
    if (!pw) return res;
    res = await send(pw);
    if (res.status === 401) {
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
  }
  return res;
}
