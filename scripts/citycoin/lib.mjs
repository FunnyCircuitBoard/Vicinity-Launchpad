/**
 * Citycoin.dev master v5, stage S08: what the census (scripts/citycoin/census.mjs) and the backup step (scripts/citycoin/backup.mjs) share.
 * Operator tools: nothing in the Worker imports this folder. docs/citycoin-master/schema-migrations.md section 8 is the owner's guide.
 *
 *   REPO_ROOT, WRANGLER_JS   this checkout and the wrangler it pins (package.json devDependencies)
 *   Refusal                  a named error for a refused request: the CLIs print its message and exit 2 before running anything
 *   wranglerEnv()            the environment of every wrangler child process. Wrangler appends EVERY line it prints, `--json` query results
 *                            included, to a debug log under ~/.config/.wrangler/logs (or WRANGLER_LOG_PATH) unless WRANGLER_WRITE_LOGS is
 *                            "false"; a census reads rows into memory to hash them, so without this they would land on disk. Also no
 *                            metrics, no error reports, no banner (the banner is what runs wrangler's npm update check) and no fetch of
 *                            workers.cloudflare.com/cf.json by the local Miniflare that `--local` commands start (CLOUDFLARE_CF_FETCH_ENABLED).
 *   runWrangler(args, opts)  run `node <WRANGLER_JS> ...args` from REPO_ROOT with that environment; `capture` (default) answers
 *                            { code, stdout, stderr } in memory and never writes them anywhere; `inherit: true` lets the operator see
 *                            wrangler's own prompts (a remote export asks before it starts)
 *   outsideRepository(p, what)  the real path of `p` when it is outside this repository and outside every git work tree; refuses `..`
 *                            segments (a symlink before them would make the kernel's path differ from the written one)
 *   databaseNameFromConfig(config)  the first d1_databases database_name of a wrangler config (wrangler.jsonc by default)
 *   parseArgs(argv, spec)    a small strict parser: --name value, --name=value, flags; an unknown option is a Refusal
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const WRANGLER_JS = path.join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
export const DEFAULT_CONFIG = path.join(REPO_ROOT, "wrangler.jsonc");

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

export function wranglerEnv(base = process.env) {
  return {
    ...base,
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
  };
}

const MAX_BUFFER = 512 * 1024 * 1024;

export function runWrangler(args, { inherit = false, timeoutMs = 15 * 60_000 } = {}) {
  if (!existsSync(WRANGLER_JS)) return Promise.reject(new Refusal(`wrangler is not installed in this checkout (${WRANGLER_JS}); run npm ci first`));
  if (inherit) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WRANGLER_JS, ...args], { cwd: REPO_ROOT, env: wranglerEnv(), stdio: "inherit" });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: "", stderr: "" }); });
    });
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [WRANGLER_JS, ...args], { cwd: REPO_ROOT, env: wranglerEnv(), maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

export function outsideRepository(target, what, root = REPO_ROOT) {
  if (typeof target !== "string" || !target.trim()) throw new Refusal(`${what}: a path is required`);
  if (target.split(/[\\/]+/).includes("..")) throw new Refusal(`${what}: write the path without ".." segments (refused ${target})`);
  const abs = path.resolve(target);
  let probe = abs;
  const rest = [];
  while (!existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    rest.unshift(path.basename(probe));
    probe = up;
  }
  const real = path.join(realpathSync(probe), ...rest);
  const realRoot = realpathSync(root);
  if (real === realRoot || real.startsWith(realRoot + path.sep)) {
    throw new Refusal(`${what} must be outside the repository (${realRoot}); refused ${target}`);
  }
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) throw new Refusal(`${what} must not be inside a git work tree (${dir}); refused ${target}`);
    if (path.dirname(dir) === dir) break;
  }
  return real;
}

export function databaseNameFromConfig(config = DEFAULT_CONFIG) {
  let text;
  try { text = readFileSync(config, "utf8"); }
  catch { throw new Refusal(`cannot read the wrangler config ${config}`); }
  const m = /"database_name"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) throw new Refusal(`the wrangler config ${config} names no D1 database_name`);
  return checkDatabaseName(m[1]);
}

export function checkDatabaseName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Refusal(`not a D1 database name: ${JSON.stringify(String(name).slice(0, 80))}`);
  return name;
}

export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (flags.includes(name)) {
      if (eq >= 0) throw new Refusal(`--${name} takes no value`);
      opts[name] = true;
    } else if (values.includes(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "" || (eq < 0 && v.startsWith("--"))) throw new Refusal(`--${name} needs a value`);
      if (name in opts) throw new Refusal(`--${name} given twice`);
      opts[name] = v;
    } else {
      throw new Refusal(`unknown option ${a.slice(0, 60)}`);
    }
  }
  return { opts, positionals };
}

/** The local-or-remote choice of a CLI: exactly one of --local and --remote, or `fallback` when neither is given (null: required). */
export function targetOf(opts, fallback = "local") {
  if (opts.local && opts.remote) throw new Refusal("use --local or --remote, not both");
  if (opts.remote) return "remote";
  if (opts.local) return "local";
  if (!fallback) throw new Refusal("name the database to act on: --remote (the production database, credential holder only) or --local");
  return fallback;
}

/** `wrangler` followed by the arguments, quoted for a POSIX shell, for the plans the tools print. */
export function shellLine(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(" ");
}
