/* Shared ESM resolver shim: lets Node run the repo's TypeScript modules
 * (which import each other without extensions) unchanged. Used by the test
 * suite, the DB ingester and any other Node tooling in this repo. */
import { registerHooks } from "node:module";

const EXTENSIONLESS = /^\.{1,2}\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (EXTENSIONLESS.test(specifier) && !/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          /* fall through to the original error */
        }
      }
      throw err;
    }
  },
});
