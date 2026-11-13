// The words a merchant and a customer read for a Gemini event: "Lions at Bears", "the Lions win".
// Built from Gemini's own data, never from what a merchant types, so a promo's card cannot name a
// different result from the one its contract settles on.
import { toUnix, type GeminiContract, type GeminiEvent } from "./gemini.ts";

export type Display = {
  /** "Cavaliers at Heat" for a game; the event's title for anything else. */
  game: string;
  /** The result as a short name: "Heat", "Georgia", "Up". */
  team: string;
  /** The team as the subject of a sentence: "the Heat", "Georgia". Empty when the event is not a game. */
  subject: string;
  /** What has to happen, to follow the words "free if": "the Heat win", "Georgia wins". */
  condition: string;
  /** Gemini's league name, for example "Pro Basketball". Null when the event has none. */
  league: string | null;
  /** Unix seconds the event starts. Null when Gemini gives no start time. */
  startTime: number | null;
};

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/**
 * A pro team's nickname. Gemini labels a contract with the city ("Miami", "New York R") and gives the
 * full name on the participant ("Miami Heat", "New York Rangers"); the nickname is what is left of the
 * full name after the words the two share. Returns the label when nothing is left.
 */
export function nickname(label: string, fullName: string): string {
  const short = words(label);
  const full = words(fullName);
  let shared = 0;
  while (shared < short.length && shared < full.length && short[shared] === full[shared]) shared++;
  const rest = full.slice(shared).join(" ");
  return shared === 0 || rest === "" ? label : rest;
}

const isPro = (event: GeminiEvent): boolean => event.subcategory?.name.startsWith("Pro ") ?? false;

/** People say a pro team's nickname ("the Heat") and a college's or a fighter's own name ("Georgia"). */
function shortName(event: GeminiEvent, contract: GeminiContract): string {
  if (!isPro(event) || !contract.sportsSide) return contract.label;
  const participant = event.participants?.find((p) => p.side === contract.sportsSide);
  return participant ? nickname(contract.label, participant.name) : contract.label;
}

export function displayNames(event: GeminiEvent, contract: GeminiContract): Display {
  const league = event.subcategory?.name ?? null;
  const startTime = event.startTime ? toUnix(event.startTime) : null;
  const team = shortName(event, contract);

  if (!contract.sportsSide) {
    // Not a game: a crypto window, a temperature bucket. "BTC price today at 12:15am EST is Up".
    return { game: event.title, team, subject: "", condition: `${event.title} is ${contract.label}`, league, startTime };
  }

  const home = event.contracts.find((c) => c.sportsSide === "home");
  const away = event.contracts.find((c) => c.sportsSide === "away");
  const game = home && away ? `${shortName(event, away)} at ${shortName(event, home)}` : event.title;
  // "The Heat win" and "the Jazz win", but "Georgia wins".
  const plural = isPro(event) && team !== contract.label;
  const subject = plural ? `the ${team}` : team;
  return { game, team, subject, condition: `${subject} ${plural ? "win" : "wins"}`, league, startTime };
}
