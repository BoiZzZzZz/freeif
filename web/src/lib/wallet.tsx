"use client";

// The login and the wallet, for merchants and customers alike: an email code through Circle's
// user-controlled wallets, on Arc testnet. Nobody here sees a wallet; the pages call it "your account"
// and "your balance".
//
// How Circle works: every action a user takes (creating the wallet, signing, sending) is a "challenge".
// Our server asks Circle for one with the API key and the user's token (the routes under
// /api/wallet), and the SDK in the browser runs it in Circle's own window, an iframe it adds to the
// page. The order of calls is the one proven in the Nov 13 spike.
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { KEYS, readLocal, saveLocal, useLocal } from "./local";

export type Session = {
  userToken: string;
  encryptionKey: string;
  email: string;
  walletId: string;
  address: `0x${string}`;
  /** When the user token was issued, in milliseconds. It lasts 60 minutes. */
  at: number;
};

/** The text on Circle's confirmation screens. */
export type Words = Parameters<W3SSdk["setLocalizations"]>[0];

/** `cancelled`: the person closed Circle's window. `login`: the hour is up, log in again. */
export class WalletError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// A user token lasts 60 minutes; stop using it a little before that.
const SESSION_MS = 55 * 60_000;
// Circle's codes for a mistyped code. Its window stays open for another try, so these are not the end.
const WRONG_CODE = new Set([155133, 155134]);
const USER_CANCELED = 155701;

type Tokens = { deviceToken: string; deviceEncryptionKey: string; otpToken: string };
type Opened = { wallet?: { id: string; address: `0x${string}` } | null; challengeId?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(path: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/wallet/${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new WalletError("failed", "We can't reach FreeIf right now. Try again in a moment.");
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok || json === null || json.error) {
    throw new WalletError(json?.error?.code ?? "failed", json?.error?.message ?? "Something went wrong. Try again in a moment.");
  }
  return json;
}

let loading: Promise<{ sdk: W3SSdk; appId: string }> | null = null;

/** Circle's SDK, loaded once, in the browser only: it needs `window` and adds its iframe to the page. */
function loadSdk(): Promise<{ sdk: W3SSdk; appId: string }> {
  loading ??= (async () => {
    const [{ W3SSdk: Sdk }, { appId }] = await Promise.all([
      import("@circle-fin/w3s-pw-web-sdk"),
      api<{ appId: string }>("config"),
    ]);
    const sdk = new Sdk({ appSettings: { appId } });
    // Circle's window in FreeIf's colors: ink buttons on white.
    sdk.setThemeColor({
      mainBtnBg: "#010304",
      mainBtnBgOnHover: "#2b2d2e",
      mainBtnText: "#ffffff",
      mainBtnTextOnHover: "#ffffff",
      textInteractive: "#010304",
      inputBorderFocused: "#010304",
    });
    return { sdk, appId };
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * Calls back when Circle's window has been closed. The SDK tells us when a challenge finishes or
 * fails, but says nothing when the person closes the window, so without this a closed window would
 * leave the page waiting forever. The short wait lets a normal finish, which also removes the
 * window, arrive first.
 */
function whenWindowCloses(onClosed: () => void): () => void {
  let seen = false;
  const timer = window.setInterval(() => {
    const open = document.getElementById("sdkIframe") !== null;
    if (open) seen = true;
    else if (seen) {
      window.clearInterval(timer);
      window.setTimeout(onClosed, 700);
    }
  }, 250);
  return () => window.clearInterval(timer);
}

/** Runs one challenge in Circle's window. Resolves with the signature when the challenge signs something. */
function runChallenge(sdk: W3SSdk, challengeId: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const stop = whenWindowCloses(() => reject(new WalletError("cancelled", "")));
    sdk.execute(challengeId, (error, result) => {
      stop();
      if (error) {
        const cancelled = error.code === USER_CANCELED;
        reject(new WalletError(cancelled ? "cancelled" : "failed", cancelled ? "" : "That didn't go through. Try again."));
        return;
      }
      const data = result && "data" in result ? result.data : undefined;
      resolve(data?.signature);
    });
  });
}

type Wallet = {
  /** Null when nobody is logged in. */
  session: Session | null;
  /** Loads Circle's SDK ahead of the first tap. */
  warm: () => void;
  /** Emails a code, lets Circle's window take it, and makes sure the account has a wallet on Arc. */
  login: (email: string) => Promise<Session>;
  logout: () => void;
  /** Calls one of the /api/wallet routes with the login's token and wallet. */
  call: <T>(path: string, body?: object) => Promise<T>;
  /** Shows one of Circle's confirmation screens, with our words on it. */
  confirm: (challengeId: string, words: Words) => Promise<string | undefined>;
};

const WalletContext = createContext<Wallet | null>(null);

const current = (): Session | null => {
  const session = readLocal<Session | null>(KEYS.session, null);
  return session && Date.now() - session.at < SESSION_MS ? session : null;
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const stored = useLocal<Session | null>(KEYS.session, null);

  // Forget a login whose hour has passed, now and when it runs out while the page is open.
  useEffect(() => {
    if (!stored) return;
    const left = stored.at + SESSION_MS - Date.now();
    const timer = window.setTimeout(() => saveLocal(KEYS.session, null), Math.max(left, 0));
    return () => window.clearTimeout(timer);
  }, [stored]);

  const logout = useCallback(() => saveLocal(KEYS.session, null), []);

  const warm = useCallback(() => {
    loadSdk().catch(() => undefined);
  }, []);

  const login = useCallback(async (rawEmail: string): Promise<Session> => {
    const email = rawEmail.trim();
    const { sdk, appId } = await loadSdk().catch(() => {
      throw new WalletError("failed", "We couldn't start the login. Check your connection and try again.");
    });
    const deviceId = await sdk.getDeviceId().catch(() => {
      throw new WalletError("failed", "We couldn't start the login. Check your connection and try again.");
    });
    const sendCode = () => api<Tokens>("email-token", { deviceId, email });
    const first = await sendCode();

    const result = await new Promise<{ userToken: string; encryptionKey: string }>((resolve, reject) => {
      let stop = () => {};
      const use = (tokens: Tokens) =>
        sdk.updateConfigs({ appSettings: { appId }, loginConfigs: tokens }, (error, done) => {
          if (done) {
            stop();
            resolve(done);
          } else if (error && !WRONG_CODE.has(error.code ?? -1)) {
            stop();
            reject(new WalletError("failed", "That code didn't work. Ask for a new one."));
          }
        });
      use(first);
      // "Send it again" in Circle's window: a new code, and the tokens that go with it.
      sdk.setOnResendOtpEmail(() => {
        sendCode().then(use, () => undefined);
      });
      sdk.setLocalizations({
        emailOtp: { title: "Enter your code", subtitle: `We sent a 6-digit code to ${email}.`, resend: "Send it again" },
      });
      sdk.verifyOtp();
      stop = whenWindowCloses(() => reject(new WalletError("cancelled", "")));
    });

    // The wallet: there already for a returning user, created now for a new one. No PIN, no questions.
    sdk.setAuthentication({ userToken: result.userToken, encryptionKey: result.encryptionKey });
    let opened = await api<Opened>("open", { userToken: result.userToken });
    if (!opened.wallet && opened.challengeId) {
      await runChallenge(sdk, opened.challengeId);
      // Circle lists the new wallet a second or two after the challenge.
      for (let i = 0; i < 20 && !opened.wallet; i++) {
        await sleep(1500);
        opened = await api<Opened>("open", { userToken: result.userToken, create: false });
      }
    }
    if (!opened.wallet) throw new WalletError("failed", "We couldn't set up your account right now. Try again in a moment.");

    const session: Session = {
      userToken: result.userToken,
      encryptionKey: result.encryptionKey,
      email,
      walletId: opened.wallet.id,
      address: opened.wallet.address,
      at: Date.now(),
    };
    saveLocal(KEYS.session, session);
    return session;
  }, []);

  const call = useCallback(async <T,>(path: string, body: object = {}): Promise<T> => {
    const session = current();
    if (!session) {
      saveLocal(KEYS.session, null);
      throw new WalletError("login", "Please log in again.");
    }
    try {
      return await api<T>(path, { ...body, userToken: session.userToken, walletId: session.walletId });
    } catch (err) {
      if (err instanceof WalletError && err.code === "login") saveLocal(KEYS.session, null);
      throw err;
    }
  }, []);

  const confirm = useCallback(async (challengeId: string, words: Words): Promise<string | undefined> => {
    const session = current();
    if (!session) throw new WalletError("login", "Please log in again.");
    const { sdk } = await loadSdk();
    sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
    sdk.setLocalizations(words);
    return runChallenge(sdk, challengeId);
  }, []);

  const value = useMemo(
    () => ({ session: stored, warm, login, logout, call, confirm }),
    [stored, warm, login, logout, call, confirm],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): Wallet {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet needs a WalletProvider above it");
  return wallet;
}
