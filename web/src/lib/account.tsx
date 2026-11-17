"use client";

// A merchant's account on /merchant: its balance, and the starter test dollars.
//
// A new account holds nothing. The keeper gives a few test dollars once per email login (its `/health`
// says how much and how many are left). They used to be offered only when Pay found the balance short;
// now they are offered before anyone logs in, and an account that may have them gets them as soon as it is
// logged in on this page, so the form can size a promo to a balance that is already there.
//
// One provider holds it for the page, so the header, the account card, the form and the Pay sheet all read
// the same balance and the same grant.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usdcBalance } from "./balance";
import { keeper, KeeperError, type StarterInfo } from "./keeper";
import { KEYS, NO_STARTER, readLocal, saveLocal, useLocal } from "./local";
import { useWallet, type Session } from "./wallet";

/** `asking`: the test dollars are on their way. `failed`: they were not sent, and `message` says why. */
export type Grant = { state: "idle" | "asking" | "given" | "failed"; message?: string };

type Account = {
  /** Null when nobody is logged in. */
  address: `0x${string}` | null;
  /** Base units. Null when nobody is logged in, or while the first read is out. */
  balance: bigint | null;
  /** The keeper's starter test dollars: undefined while it is being asked, null when it gives none. */
  starter: StarterInfo | null | undefined;
  /** True when the keeper gives them now and this account (or a visitor not logged in yet) can have them. */
  offered: boolean;
  /** True when this account has had its test dollars. */
  had: boolean;
  grant: Grant;
  /** Reads the balance again. Rejects when the chain cannot be read. */
  refresh: () => Promise<bigint | null>;
  /** Asks for the test dollars now. Resolves when they have arrived or been refused; `grant` says which. */
  claim: () => Promise<void>;
  /** Waits for anything on its way (the first read, a grant), then gives a fresh balance. */
  settle: () => Promise<bigint | null>;
};

const AccountContext = createContext<Account | null>(null);

// The keeper's answers when the login is no good: the login is forgotten and the email step comes back.
const LOGIN_AGAIN = new Set(["login", "not-your-wallet"]);
const IDLE: Grant = { state: "idle" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hadLocal = (key: string): boolean => readLocal<Record<string, true>>(KEYS.starter, NO_STARTER)[key] === true;
const remember = (key: string) =>
  saveLocal(KEYS.starter, { ...readLocal<Record<string, true>>(KEYS.starter, NO_STARTER), [key]: true });

/** What the keeper gives, or null when it gives none, is slow, cannot be reached or is older than them. */
async function readOffer(): Promise<StarterInfo | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    return (await keeper.health(controller.signal)).starter ?? null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const session = wallet.session;
  const address = session?.address ?? null;
  const key = address?.toLowerCase() ?? null;
  const hadMap = useLocal<Record<string, true>>(KEYS.starter, NO_STARTER);
  const had = key !== null && hadMap[key] === true;

  const [starter, setStarter] = useState<StarterInfo | null | undefined>(undefined);
  // Each kept with the account it belongs to, so one account's numbers never show for another.
  const [held, setHeld] = useState<{ key: string; value: bigint } | null>(null);
  const [granted, setGranted] = useState<{ key: string; grant: Grant } | null>(null);
  const balance = held !== null && held.key === key ? held.value : null;
  const grant = granted !== null && granted.key === key ? granted.grant : IDLE;

  // The keeper's offer, asked once per page and again after every grant (its count goes down).
  const offer = useRef<Promise<StarterInfo | null> | null>(null);
  const askOffer = useCallback((): Promise<StarterInfo | null> => {
    const asked = readOffer();
    offer.current = asked;
    void asked.then((info) => {
      if (offer.current === asked) setStarter(info);
    });
    return asked;
  }, []);
  useEffect(() => {
    void askOffer();
  }, [askOffer]);

  // What is on its way for an account: its first read and, when it may have them, its test dollars.
  const flights = useRef(new Map<string, Promise<void>>());
  const logout = wallet.logout;

  const read = useCallback(async (who: `0x${string}`): Promise<bigint> => {
    const value = await usdcBalance(who);
    setHeld({ key: who.toLowerCase(), value });
    return value;
  }, []);

  /** Sends for the test dollars and waits for them to show in the balance. `quiet`: started by the page, not a tap. */
  const send = useCallback(
    async (who: Session, before: bigint | null, quiet: boolean): Promise<void> => {
      const id = who.address.toLowerCase();
      setGranted({ key: id, grant: { state: "asking" } });
      try {
        // The login token goes with it: the keeper asks Circle whose account this is, as for a claim.
        await keeper.starter(who.address, who.userToken);
        remember(id);
        // The keeper has the receipt; the node the browser reads from can be a block behind it.
        for (let i = 0; i < 6; i++) {
          const now = await read(who.address).catch(() => null);
          if (now !== null && (before === null || now > before)) break;
          await sleep(700);
        }
        setGranted({ key: id, grant: { state: "given" } });
      } catch (err) {
        const code = err instanceof KeeperError ? err.code : "failed";
        if (LOGIN_AGAIN.has(code)) {
          // Forgotten, so the email step is there again.
          setGranted({ key: id, grant: IDLE });
          logout();
          return;
        }
        if (code === "already") remember(id);
        // An account that had them, or holds enough already, needs no line about it when nobody asked.
        const silent = quiet && (code === "already" || code === "funded");
        const message = err instanceof KeeperError ? err.message : "Something went wrong. Try again in a moment.";
        setGranted({ key: id, grant: silent ? IDLE : { state: "failed", message } });
      } finally {
        void askOffer();
      }
    },
    [read, logout, askOffer],
  );

  /** One flight per account at a time: a second caller waits on the first. */
  const fly = useCallback((id: string, run: () => Promise<void>): Promise<void> => {
    const running = flights.current.get(id);
    if (running) return running;
    const flight = run()
      .catch(() => undefined)
      .finally(() => {
        if (flights.current.get(id) === flight) flights.current.delete(id);
      });
    flights.current.set(id, flight);
    return flight;
  }, []);

  // A login on this page: read the balance, and give the account its test dollars when it may have them.
  useEffect(() => {
    if (!session) return;
    const who = session;
    const id = who.address.toLowerCase();
    void fly(id, async () => {
      const [value, info] = await Promise.all([usdcBalance(who.address), offer.current ?? askOffer()]);
      const due = info !== null && info.left > 0 && !hadLocal(id) && value < BigInt(info.amount);
      // Both in one step, so the page never shows an empty balance with nothing on its way.
      setHeld({ key: id, value });
      if (due) await send(who, value, true);
    });
    // Only a new login starts it: the same account with a newer token is the same account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fly, send, askOffer]);

  // Money can arrive from elsewhere (a transfer, a payout): read again when the page is looked at again.
  useEffect(() => {
    if (!address) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void read(address).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [address, read]);

  const refresh = useCallback(async (): Promise<bigint | null> => (address ? read(address) : null), [address, read]);

  const claim = useCallback(async (): Promise<void> => {
    if (!session) return;
    const id = session.address.toLowerCase();
    await flights.current.get(id);
    await fly(id, () => send(session, held !== null && held.key === id ? held.value : null, false));
  }, [session, held, fly, send]);

  const settle = useCallback(async (): Promise<bigint | null> => {
    if (!address) return null;
    await flights.current.get(address.toLowerCase());
    return read(address);
  }, [address, read]);

  const amount = starter ? BigInt(starter.amount) : null;
  const offered =
    starter !== null && starter !== undefined && starter.left > 0 && !had && (address === null || (balance !== null && amount !== null && balance < amount));

  const value = useMemo(
    () => ({ address, balance, starter, offered, had, grant, refresh, claim, settle }),
    [address, balance, starter, offered, had, grant, refresh, claim, settle],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount needs an AccountProvider above it");
  return account;
}
