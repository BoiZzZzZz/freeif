// The QuickNode Stream that feeds the keeper's `POST /stream`: made, tested, paused and removed from
// here, so its settings are in this file and not only in a dashboard.
//
//   node scripts/stream.ts status          our Stream at QuickNode, if there is one
//   node scripts/stream.ts test [block]    run stream/filter.js at QuickNode on one block
//                                          (default: the block of the vault's newest event)
//   node scripts/stream.ts on              remove our Stream if there is one, start a new one at the newest block
//   node scripts/stream.ts off             pause it
//   node scripts/stream.ts remove          delete it
//
// Needs QUICKNODE_API_KEY (dashboard.quicknode.com/api-keys, with the Streams permission),
// QUICKNODE_STREAM_SECRET and VAULT_ADDRESS. The webhook is KEEPER_URL/stream; KEEPER_URL defaults to the
// hosted keeper.
//
// Why "on" makes a new Stream instead of resuming the paused one: a Stream is billed for every block it
// reads, vault event or not, and a paused Stream resumes at the block it stopped at. A new one starts at
// the newest block. Nothing is lost by the gap: the keeper reads the chain for whatever no delivery
// brought (src/stream.ts).
import { readFileSync } from "node:fs";
import * as config from "../src/config.ts";

const API = "https://api.quicknode.com/streams/rest/v1";
const NAME = "freeif-vault";
const NETWORK = "arc-testnet";
const DATASET = "logs";
/**
 * Blocks in one delivery. 1 is tried first. QuickNode's docs ask for at least 5 on a chain with blocks under
 * a second; on Nov 13 it took 1 for Arc testnet and the Stream stayed at the newest block.
 */
const BATCH_SIZES = [1, 5];

const apiKey = config.env("QUICKNODE_API_KEY");
const secret = config.env("QUICKNODE_STREAM_SECRET");
const vault = config.vaultAddress().toLowerCase();
const keeperUrl = (process.env.KEEPER_URL ?? "https://freeif-production.up.railway.app").replace(/\/$/, "");

type Stream = {
  id: string;
  name: string;
  status: string;
  network: string;
  dataset: string;
  dataset_batch_size?: number;
  destination_attributes?: Record<string, unknown>;
  [key: string]: unknown;
};

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function qn<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `${method} ${path} answered ${res.status}: ${text.slice(0, 600)}`);
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** The filter as it is uploaded: stream/filter.js with the vault's address in it, base64. */
function filterFunction(): string {
  const source = readFileSync(new URL("../stream/filter.js", import.meta.url), "utf8");
  const line = /var VAULT = "0x[0-9a-fA-F]{40}";/;
  if (!line.test(source)) throw new Error("stream/filter.js has no `var VAULT = \"0x...\";` line");
  return Buffer.from(source.replace(line, `var VAULT = "${vault}";`)).toString("base64");
}

/** Our Stream, found by its name. */
async function ours(): Promise<Stream | null> {
  const list = await qn<{ data?: Stream[] } | Stream[]>("GET", "/streams?limit=100&offset=0");
  const streams = Array.isArray(list) ? list : (list.data ?? []);
  return streams.find((s) => s.name === NAME) ?? null;
}

/** A Stream without its secrets, for printing. */
function show(stream: Stream): void {
  const attributes = { ...(stream.destination_attributes ?? {}) };
  if (attributes.headers) attributes.headers = Object.keys(attributes.headers as object);
  if (attributes.security_token) attributes.security_token = "(set)";
  const { filter_function: filter, ...rest } = stream;
  console.log({ ...rest, filter_function: typeof filter === "string" ? `(${filter.length} base64 characters)` : filter, destination_attributes: attributes });
}

async function test(block: string | undefined): Promise<void> {
  let target = block;
  if (target === undefined) {
    const feed = (await (await fetch(`${keeperUrl}/feed?limit=1`)).json()) as { events: Array<{ block: number; event: string }> };
    const newest = feed.events.at(-1);
    if (!newest) throw new Error("the keeper has no vault event yet: name a block");
    target = String(newest.block);
    console.log(`block ${target}: the vault's newest event, ${newest.event}`);
  }
  const answer = await qn<{ logs?: unknown[]; result?: string }>("POST", "/streams/test_filter", {
    network: NETWORK,
    dataset: DATASET,
    filter_function: filterFunction(),
    block: target,
  });
  let result: unknown = answer.result;
  try {
    if (typeof result === "string") result = JSON.parse(result);
  } catch {
    // Left as the text QuickNode sent.
  }
  console.log("the filter's answer for that block:");
  console.dir(result, { depth: 6 });
  if (answer.logs?.length) console.log("its console output:", answer.logs);
}

async function on(): Promise<void> {
  const old = await ours();
  if (old) {
    await qn("DELETE", `/streams/${old.id}`);
    console.log(`removed the old Stream ${old.id} (${old.status})`);
  }
  const settings = (batch: number) => ({
    name: NAME,
    network: NETWORK,
    dataset: DATASET,
    filter_function: filterFunction(),
    region: "usa_east",
    dataset_batch_size: batch,
    elastic_batch_enabled: true,
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    destination: "webhook",
    destination_attributes: {
      url: `${keeperUrl}/stream`,
      compression: "none",
      // The keeper takes a delivery with QuickNode's signature (made with `security_token`) or with this header.
      headers: { "x-stream-secret": secret },
      security_token: secret,
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 10,
    },
    status: "active",
  });

  let created: Stream | null = null;
  for (const batch of BATCH_SIZES) {
    try {
      created = await qn<Stream>("POST", "/streams", settings(batch));
      console.log(`started with ${batch} block${batch === 1 ? "" : "s"} per delivery`);
      break;
    } catch (err) {
      // QuickNode refuses a batch that is too small for the chain; the next size is tried.
      const tooSmall = err instanceof ApiError && err.status >= 400 && err.status < 500 && /batch/i.test(err.message);
      if (!tooSmall || batch === BATCH_SIZES.at(-1)) throw err;
      console.log(`${batch} block per delivery was refused: ${err.message}`);
    }
  }
  if (created) show(created);
  console.log(`\nwebhook: ${keeperUrl}/stream. Deliveries so far: curl ${keeperUrl}/health`);
}

async function withOurs(run: (stream: Stream) => Promise<void>): Promise<void> {
  const stream = await ours();
  if (!stream) {
    console.log(`no Stream named ${NAME} at QuickNode`);
    return;
  }
  await run(stream);
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "status":
    await withOurs(async (stream) => show(await qn<Stream>("GET", `/streams/${stream.id}`)));
    break;
  case "test":
    await test(argument);
    break;
  case "on":
    await on();
    break;
  case "off":
    await withOurs(async (stream) => {
      await qn("POST", `/streams/${stream.id}/pause`);
      console.log(`paused ${stream.id}`);
    });
    break;
  case "remove":
    await withOurs(async (stream) => {
      await qn("DELETE", `/streams/${stream.id}`);
      console.log(`removed ${stream.id}`);
    });
    break;
  default:
    console.log("usage: node scripts/stream.ts status | test [block] | on | off | remove");
    process.exitCode = 1;
}
