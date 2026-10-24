// Written by scripts/pages/build.mjs from the settings of wrangler.jsonc; do not edit (test/build-parity.test.js checks it).
// What the deployed pages in public/ were built with, and whether wrangler.jsonc sends them through the Worker (run_worker_first true).
// src/v5policy.js counts MAIN_TOKEN_V5 only when mainTokenV5 is true here, and HOST_REDIRECT only when pagesReachWorker is true.
export const PAGES_BUILT = Object.freeze({ mainTokenV5: false, brand: "", pagesReachWorker: false });
