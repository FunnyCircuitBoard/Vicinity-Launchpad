/**
 * What a server keeps in memory that an admin's change must drop at once (src/cointakedown.js: a takedown changes a coin's words). A
 * module that keeps such a copy registers how to forget it (src/launchpad.js its list); forgetCopies drops them all. A plain module with
 * no imports, so neither side imports the other: an import cycle, or a dynamic import (which makes the bundler wrap the imported module
 * and everything it imports in lazy initializers, slower at every server's start: PARITY-STARTUP-1), is never needed.
 */
const forgetters = new Set();
export const onForget = (fn) => { forgetters.add(fn); };
export function forgetCopies(env) {
  for (const fn of forgetters) { try { fn(env); } catch { /* a copy is rebuilt within 30 seconds anyway */ } }
}
