// The store's vault stamp, in a temporary directory: a file with no stamp is taken, a file of another
// vault is set aside, and a vault's own file is taken back.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import "../src/config.ts";
import { Store, asideName, type Data } from "../src/store.ts";

const VAULT: Address = "0x68a00243927f250dBcD9160b5d06623b62B2e06d";
const OTHER: Address = "0x828295d7213DBA6eB281354d61801082006f72e6";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const ALICE: Address = "0x6f3DE22768B24a4cAE412BF3575E691488B7d6E4";
const BOB: Address = "0x7DA5F6f9bbEBf584f71CdD082aeBEaF46fa7E799";
const KEY = "the-backup-key";
const NOW = 1_794_500_000;

const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const quiet = () => undefined;
const label = (item: string) => ({ item, business: "Tony's Pizza" });

// ---- The store's vault stamp ----

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "freeif-backup-"));
}
const onDisk = (dir: string, name = "keeper.json") => JSON.parse(readFileSync(join(dir, name), "utf8")) as Data;

test("store_aFileWithNoStamp_isTakenAndStamped", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ promoLabels: { "9": label("Wings") } }));
    const lines: string[] = [];
    const store = new Store(dir, VAULT, (line) => lines.push(line));
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.equal(store.data.vault, VAULT);
    assert.equal(onDisk(dir).vault, VAULT, "the stamp is on disk at once");
    assert.equal(lines.length, 1);
    // The next start finds the stamp and says nothing.
    new Store(dir, VAULT, (line) => lines.push(line));
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aFileOfAnotherVault_isSetAside_andTheKeeperStartsEmpty", () => {
  const dir = tempDir();
  try {
    const first = new Store(dir, VAULT, quiet);
    first.data.promoLabels["9"] = label("Wings");
    first.save();

    const lines: string[] = [];
    const second = new Store(dir, OTHER, (line) => lines.push(line));
    assert.deepEqual(second.data.promoLabels, {});
    assert.equal(second.data.vault, OTHER);
    assert.equal(lines.length, 1, "one line says what happened");
    assert.match(lines[0]!, /set it aside as keeper\.0x68a00243927f250dbcd9160b5d06623b62b2e06d\.json/);
    assert.deepEqual(onDisk(dir, asideName(VAULT)).promoLabels, { "9": label("Wings") });
    assert.equal(onDisk(dir).vault, OTHER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_backOnTheFirstVault_takesItsFileBack_andSetsTheOtherAside", () => {
  const dir = tempDir();
  try {
    const a = new Store(dir, VAULT, quiet);
    a.data.promoLabels["9"] = label("Wings");
    a.save();
    const b = new Store(dir, OTHER, quiet);
    b.data.promoLabels["0"] = label("Fries");
    b.save();

    const lines: string[] = [];
    const again = new Store(dir, VAULT, (line) => lines.push(line));
    assert.deepEqual(again.data.promoLabels, { "9": label("Wings") });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /took back keeper\.0x68a0.*\.json/);
    assert.deepEqual(onDisk(dir, asideName(OTHER)).promoLabels, { "0": label("Fries") });
    // Nothing was deleted: the live file and the other vault's.
    assert.deepEqual(readdirSync(dir).sort(), [asideName(OTHER), "keeper.json"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_theStampIsComparedWithoutCase", () => {
  const dir = tempDir();
  try {
    const a = new Store(dir, VAULT, quiet);
    a.data.promoLabels["9"] = label("Wings");
    a.save();
    const lines: string[] = [];
    const same = new Store(dir, VAULT.toLowerCase() as Address, (line) => lines.push(line));
    assert.deepEqual(same.data.promoLabels, { "9": label("Wings") });
    assert.deepEqual(lines, []);
    assert.deepEqual(readdirSync(dir), ["keeper.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aRunThatStoppedHalfWay_findsThisVaultsFileSetAside", () => {
  const dir = tempDir();
  try {
    // keeper.json was set aside and the keeper stopped before taking its own file back.
    writeFileSync(join(dir, asideName(VAULT)), JSON.stringify({ vault: VAULT, promoLabels: { "9": label("Wings") } }));
    const store = new Store(dir, VAULT, quiet);
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.deepEqual(readdirSync(dir), ["keeper.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_aSetAsideNameThatIsTaken_isNotOverwritten", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, asideName(VAULT)), JSON.stringify({ vault: VAULT, promoLabels: { "1": label("Old") } }));
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ vault: VAULT, promoLabels: { "2": label("New") } }));
    new Store(dir, OTHER, quiet);
    const files = readdirSync(dir);
    assert.equal(files.length, 3, "both of the first vault's files are kept");
    assert.ok(files.includes(asideName(VAULT)));
    assert.deepEqual(onDisk(dir, asideName(VAULT)).promoLabels, { "1": label("Old") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store_withNoVault_readsTheFileAsBefore", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "keeper.json"), JSON.stringify({ vault: OTHER, promoLabels: { "9": label("Wings") } }));
    const store = new Store(dir);
    assert.deepEqual(store.data.promoLabels, { "9": label("Wings") });
    assert.equal(new Store(null).data.vault, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
