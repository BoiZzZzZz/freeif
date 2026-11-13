// What this browser remembers between visits. None of it is trusted by the server: it only saves a
// merchant from typing their shop's name twice and lets a customer's card stay "Covered" after the
// login has run out.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
// One parsed value per key, replaced only when the stored text changes: `useSyncExternalStore` needs
// the same object back while nothing has changed.
const parsed = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: string, fallback: T): T {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  const held = parsed.get(key);
  if (held && held.raw === raw) return held.value as T;
  let value: unknown = fallback;
  if (raw !== null) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = fallback;
    }
  }
  parsed.set(key, { raw, value });
  return value as T;
}

export function saveLocal<T>(key: string, value: T | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing: the page still works, it just forgets.
  }
  listeners.forEach((notify) => notify());
}

export const readLocal = <T>(key: string, fallback: T): T => (typeof window === "undefined" ? fallback : read(key, fallback));

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
}

/** A stored value that re-renders its readers when it changes. On the server it is the fallback. */
export function useLocal<T>(key: string, fallback: T): T {
  return useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  );
}

export const KEYS = {
  /** The login: Circle's user token (good for an hour), the wallet and the email. */
  session: "freeif.session",
  /** The shop's name, asked once. */
  business: "freeif.business",
  /** Promos this browser paid for: `{ id, tx, at }[]`, newest first. */
  promos: "freeif.promos",
  /** Promos this browser is covered on: promo id -> the customer's address. */
  claims: "freeif.claims",
  /** "1" when the mechanics view is on. */
  mechanics: "freeif.mechanics",
} as const;

export type MyPromo = { id: string; tx: string; at: number };

// Fallbacks are shared constants: a new `[]` on every render would look like a change.
export const NO_PROMOS: MyPromo[] = [];
export const NO_CLAIMS: Record<string, string> = {};
