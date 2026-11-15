// Keeps a copy of the keeper's file on this laptop, and pushes one back into a keeper that lost it.
//
//   pnpm backup                     pull one backup from the keeper's GET /backup
//   pnpm backup --force             the same, and make it the latest even if it holds less
//   pnpm backup --watch [minutes]   pull every 10 minutes (or as given) until stopped (Ctrl+C)
//   pnpm backup --restore [file]    post a backup to the keeper's POST /restore: the file given, or the
//                                   latest for the vault the keeper's GET /health names
//
// Settings, from the environment, with secrets.env read for whatever the environment lacks (as every
// script does): KEEPER_URL (default the hosted keeper), BACKUP_KEY (the keeper's own), FREEIF_BACKUP_DIR
// (default: `backups` beside secrets.env).
//
// Each pull writes keeper-<first 8 hex of the vault>-<UTC time>.json, unless its data is the last pull's
// ("unchanged"), and makes it latest-<vault>.json, unless it holds fewer promo labels or fewer odds
// readings than the latest already there: a keeper that was just made again is empty, and its backup must
// not replace the good one. The newest 300 pulls per vault are kept.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const secretsPath = process.env.FREEIF_SECRETS ?? join(homedir(), ".freeif", "secrets.env");
if (existsSync(secretsPath)) process.loadEnvFile(secretsPath);

const KEEPER_URL = (process.env.KEEPER_URL || "https://freeif-production.up.railway.app").replace(/\/+$/, "");
const DIR = process.env.FREEIF_BACKUP_DIR || join(dirname(secretsPath), "backups");
/** Pulls kept per vault. At 10 minutes apart, two days. */
const KEEP = 300;
/**
 * The keeper keeps at most 4,000 readings per promo and, past that, drops every second one of the older
 * half, which leaves 3,000 or more. A promo with that many has been thinned, not lost.
 */
const THINNED = 3000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
/** The word after a flag, when there is one that is not another flag. */
const after = (name) => {
  const at = args.indexOf(name);
  const next = at < 0 ? undefined : args[at + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
};

function backupKey() {
  const key = process.env.BACKUP_KEY;
  if (!key) throw new Error("BACKUP_KEY is not set: put the keeper's BACKUP_KEY in secrets.env");
  return key;
}

const time = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);
const latestName = (vault) => `latest-${vault.toLowerCase()}.json`;
const prefix = (vault) => `keeper-${vault.slice(2, 10).toLowerCase()}-`;

const labels = (data) => Object.keys(data?.promoLabels ?? {}).length;
const points = (data) => Object.values(data?.odds ?? {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
const feedEvents = (data) => data?.feed?.events?.length ?? 0;

/** The data as it is compared with the last pull's: the feed's cursor moves every two seconds, and a restore never uses it. */
const comparable = (data) => JSON.stringify({ ...data, feed: { ...data.feed, cursor: null } });

/** A refusal from the keeper, in its own words when it gave some. */
async function refusal(res, what) {
  let said = "";
  try {
    const body = await res.json();
    said = body?.error?.message ? `: ${body.error.message}` : "";
  } catch {
    // Not JSON.
  }
  if (res.status === 404 && res.headers.get("x-railway-fallback")) return new Error(`${what}: the keeper is gone (Railway answers 404 for it)`);
  if (res.status === 404) return new Error(`${what} answered 404${said || " (a keeper from before backups?)"}; a keeper with no BACKUP_KEY has no backups`);
  if (res.status === 401) return new Error(`${what} answered 401: this BACKUP_KEY is not the keeper's`);
  if (res.status === 429) return new Error(`${what} answered 429: too many requests, try again in ${res.headers.get("retry-after") ?? "a few"} seconds`);
  return new Error(`${what} answered ${res.status}${said}`);
}

/** The keeper's GET /health: whether Railway still has it, and the vault it runs on. */
async function health() {
  const res = await fetch(`${KEEPER_URL}/health`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 && res.headers.get("x-railway-fallback")) return { gone: true };
  if (!res.ok) throw new Error(`GET /health answered ${res.status}`);
  const body = await res.json();
  return { gone: false, vault: body.vault, commit: body.commit };
}

/** Writes through a second file and a rename, so a crash never leaves half a file. */
function writeWhole(file, text) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** Why a fresh backup must not replace the latest: what it holds less of. Empty when it may. */
function holdsLess(fresh, latest) {
  const reasons = [];
  if (labels(fresh) < labels(latest)) reasons.push(`${plural(labels(fresh), "promo label")} against ${labels(latest)}`);
  // A promo the keeper has thinned is counted at the latest's size: thinning is not a loss.
  const before = latest?.odds ?? {};
  let counted = 0;
  for (const [id, list] of Object.entries(fresh?.odds ?? {})) {
    const n = Array.isArray(list) ? list.length : 0;
    counted += n >= THINNED ? Math.max(n, before[id]?.length ?? 0) : n;
  }
  if (counted < points(latest)) reasons.push(`${plural(points(fresh), "odds reading")} against ${points(latest)}`);
  return reasons;
}

function pulls(vault) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((name) => name.startsWith(prefix(vault)) && name.endsWith(".json")).sort();
}

/** One pull: GET /backup, the timestamped file, the latest, and the oldest pulls past 300 removed. */
async function pull(force) {
  const res = await fetch(`${KEEPER_URL}/backup`, { headers: { "x-backup-key": backupKey() }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw await refusal(res, "GET /backup");
  const text = await res.text();
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("GET /backup did not answer with JSON");
  }
  const { meta, data } = backup ?? {};
  if (meta?.version !== 1 || !ADDRESS.test(meta?.vault ?? "") || typeof data !== "object" || data === null) {
    throw new Error("GET /backup did not answer with a backup");
  }
  const vault = meta.vault;
  mkdirSync(DIR, { recursive: true });

  const counts = `${plural(labels(data), "promo")} with labels, ${plural(points(data), "odds reading")}, ${plural(feedEvents(data), "feed event")}`;
  const short = `${vault.slice(0, 6)}…${vault.slice(-4)}`;
  const last = pulls(vault).at(-1);
  let same = false;
  if (last !== undefined) {
    try {
      same = comparable(JSON.parse(readFileSync(join(DIR, last), "utf8")).data) === comparable(data);
    } catch {
      // The last pull cannot be read: this one is written.
    }
  }
  let file = null;
  if (same) {
    console.log(`${time()} vault ${short}: ${counts}, unchanged since ${last}`);
    if (!force) return { vault, file };
  } else {
    // UTC to the millisecond, without the colons a file name cannot have on Windows: names sort by time.
    file = join(DIR, `${prefix(vault)}${new Date().toISOString().replace(/:/g, "")}.json`);
    writeWhole(file, text);
    console.log(`${time()} vault ${short}: ${counts}, ${size(Buffer.byteLength(text))}, ${basename(file)}`);
  }

  const latestFile = join(DIR, latestName(vault));
  let latest = null;
  if (existsSync(latestFile)) {
    try {
      latest = JSON.parse(readFileSync(latestFile, "utf8")).data;
    } catch {
      console.log(`${time()} ${latestName(vault)} could not be read: it is replaced`);
    }
  }
  const less = latest === null ? [] : holdsLess(data, latest);
  if (less.length > 0 && !force) {
    console.log(`${time()} WARNING: this backup holds less than ${latestName(vault)} (${less.join(", ")}), so the latest is kept.`);
    console.log(`${time()}          A keeper that was just made again is empty: pnpm backup --restore. To make this one the latest anyway: pnpm backup --force`);
  } else {
    writeWhole(latestFile, text);
  }

  // The oldest pulls of this vault, past the newest 300.
  for (const old of pulls(vault).slice(0, -KEEP)) unlinkSync(join(DIR, old));
  return { vault, file };
}

/** POST /restore with a backup file, and what the keeper says it added. */
async function restore(given) {
  let file = given;
  if (file === undefined) {
    const h = await health();
    if (h.gone) throw new Error("the keeper is gone (Railway answers 404 for it): pnpm rehost and pnpm ship first");
    file = join(DIR, latestName(h.vault));
    if (!existsSync(file)) throw new Error(`no backup of vault ${h.vault} here: ${file} does not exist`);
  }
  const text = readFileSync(file, "utf8");
  const res = await fetch(`${KEEPER_URL}/restore`, {
    method: "POST",
    headers: { "x-backup-key": backupKey(), "content-type": "application/json" },
    body: text,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await refusal(res, "POST /restore");
  const { added } = await res.json();
  const parts = Object.entries(added ?? {}).filter(([, n]) => n > 0).map(([name, n]) => `${n.toLocaleString("en-US")} ${name}`);
  console.log(`restored ${basename(file)} into ${KEEPER_URL}: ${parts.length === 0 ? "nothing was new (the keeper had all of it)" : `added ${parts.join(", ")}`}`);
}

function alarm() {
  const bar = "!".repeat(100);
  console.log(`\u0007${bar}`);
  console.log(`!!! ${time()} THE KEEPER IS GONE: ${KEEPER_URL}/health answers 404 from Railway (x-railway-fallback).`);
  console.log("!!! Bring it back, from freeif/keeper/ (delete ~/.freeif/railway.json first: it names the project that was):");
  console.log("!!!     pnpm rehost      then      pnpm ship      then      pnpm backup --restore");
  console.log(bar);
}

/** A pull every `minutes` until stopped. While the keeper is gone it says so every minute. */
async function watch(minutes) {
  console.log(`${time()} a backup of ${KEEPER_URL} every ${minutes} minutes into ${DIR}. Ctrl+C stops.`);
  for (;;) {
    let wait = minutes * 60_000;
    try {
      const h = await health();
      if (h.gone) {
        alarm();
        wait = Math.min(wait, 60_000);
      } else {
        await pull(false);
      }
    } catch (err) {
      console.log(`${time()} ${err.message}`);
    }
    await sleep(wait);
  }
}

try {
  if (flag("--restore")) {
    await restore(after("--restore"));
  } else if (flag("--watch")) {
    const raw = after("--watch") ?? "10";
    const minutes = Number(raw);
    if (!(minutes > 0)) throw new Error(`--watch takes minutes, like 10, not "${raw}"`);
    await watch(minutes);
  } else {
    await pull(flag("--force"));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
