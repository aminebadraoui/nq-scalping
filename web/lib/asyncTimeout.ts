/* ------------------------------------------------------------------ *
 * withTimeout — bound a promise on the dispatch-critical path.
 *
 * The execution path must never wait unbounded on a side dependency: a
 * hung Neon query between detection and the order POST is as bad as a
 * slow REST hop. The REST calls already carry AbortSignal.timeout; this
 * helper gives the DB-backed reads the same bound.
 *
 * NOTE: the raced promise is not cancelled (postgres.js has no abort
 * hook) — the winner just stops being waited on. Callers treat a
 * timeout as "unreadable → fail the way the surrounding policy says"
 * (fail closed at the guard, best-effort elsewhere).
 * ------------------------------------------------------------------ */

export async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
