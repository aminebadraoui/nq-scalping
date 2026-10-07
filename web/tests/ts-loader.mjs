/* Re-export of the shared loader (see ../../scripts/ts-loader.mjs).
 * Also: silence the daybook journal during tests — the suite exercises
 * guardCheck/save() heavily and must never pollute the real journal dir. */
process.env.DAYBOOK_OFF = "1";
import "../../scripts/ts-loader.mjs";
