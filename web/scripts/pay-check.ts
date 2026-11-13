// Checks the server side of Pay against Arc and the hosted keeper, with the test merchant's plain key
// standing in for the Circle wallet, once for a promo and once for a cover (the business gets paid).
// Nothing is broadcast: the promo call is only simulated.
// It needs TEST_MERCHANT_PK in the secrets file outside the repo. Run: pnpm check:pay
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, Refusal } from "@/lib/server/http";
import { permitTypedData, promoCall } from "@/lib/server/promo-call";
import { keeper } from "@/lib/keeper";
import { usdcBalance } from "@/lib/balance";


async function main() {
  const account = privateKeyToAccount(env("TEST_MERCHANT_PK") as `0x${string}`);
  console.log("merchant", account.address, "balance", (await usdcBalance(account.address)).toString());

  // A real game from the keeper's list, a small promo on its less likely team: the test merchant holds little.
  const { games } = await keeper.games("nba");
  const game = games.find((g) => g.teams.some((t) => t.quotable))!;
  const team = game.teams.filter((t) => t.quotable).sort((a, b) => (a.chance ?? 1) - (b.chance ?? 1))[0]!;
  const request = {
    eventTicker: game.eventTicker,
    instrumentSymbol: team.instrumentSymbol,
    payoutPerClaim: "1000000",
    maxClaims: 2,
    claimDeadline: "start" as const,
  };
  const price = await keeper.price(request);
  console.log("game", game.game, "|", team.condition, "| chance", price.breakdown.chance, "| cost", price.breakdown.cost, "| limit", price.limit, "| max", price.maxCustomers);
  console.log("display", JSON.stringify(price.display));

  const quoted = await keeper.quote({ ...request, merchant: account.address, item: "Wings", business: "Web check (not created)" });
  console.log("quote premium", quoted.quote.premium, "expires in", quoted.quote.expiry - Math.floor(Date.now() / 1000), "s");

  // The permit, as the /api/wallet/permit route builds it, signed here the way the Circle wallet would.
  const { typed, deadline } = await permitTypedData(account.address, quoted.quote.premium);
  const message = {
    owner: typed.message.owner,
    spender: typed.message.spender,
    value: BigInt(typed.message.value),
    nonce: BigInt(typed.message.nonce),
    deadline: BigInt(typed.message.deadline),
  };
  const signable = { domain: typed.domain, types: { Permit: typed.types.Permit }, primaryType: "Permit", message } as const;
  const permitSignature = await account.signTypedData(signable);
  console.log("permit digest", hashTypedData(signable), "recovers to owner:", (await recoverTypedDataAddress({ ...signable, signature: permitSignature })) === account.address);

  // The promo call, as the /api/wallet/create-promo route builds and checks it.
  const { vault, callData } = await promoCall(account.address, quoted.quote, quoted.signature, permitSignature, deadline);
  console.log("OK: the call would succeed. vault", vault, "calldata bytes", (callData.length - 2) / 2);

  // Controls: each of these must be refused in the merchant's words.
  async function refused(label: string, run: Promise<unknown>) {
    try {
      await run;
      console.log(`NOT REFUSED: ${label}`);
    } catch (err) {
      console.log(`refused (${label}):`, err instanceof Refusal ? `${err.code} | ${err.message}` : String(err));
    }
  }
  // A permit for one cent less than the cost: the vault cannot take the premium.
  const low = await permitTypedData(account.address, (BigInt(quoted.quote.premium) - 10_000n).toString());
  const lowSig = await account.signTypedData({
    domain: low.typed.domain,
    types: { Permit: low.typed.types.Permit },
    primaryType: "Permit",
    message: { ...message, value: BigInt(low.typed.message.value), deadline: BigInt(low.typed.message.deadline) },
  });
  await refused("permit for less than the cost", promoCall(account.address, quoted.quote, quoted.signature, lowSig, low.deadline));
  // A quote whose price was changed after the keeper signed it.
  await refused(
    "a tampered quote",
    promoCall(account.address, { ...quoted.quote, premium: "10000" }, quoted.signature, permitSignature, deadline),
  );
  // A quote that has expired.
  await refused(
    "an expired quote",
    promoCall(account.address, { ...quoted.quote, expiry: 1 }, quoted.signature, permitSignature, deadline),
  );

  // The same path for a cover: one payout to the business itself, on a daily temperature market.
  const { games: days } = await keeper.weather();
  const day = days.find((d) => d.teams.some((t) => t.quotable));
  if (!day) {
    console.log("cover: no day is open right now (tomorrow's opens each morning); not checked");
    return;
  }
  const range = day.teams.find((t) => t.quotable)!;
  const cover = await keeper.quote({
    eventTicker: day.eventTicker,
    instrumentSymbol: range.instrumentSymbol,
    payoutPerClaim: "1000000",
    maxClaims: 1,
    claimDeadline: "start",
    merchant: account.address,
    item: "",
    business: "Web check (not created)",
    hedgeMode: true,
  });
  console.log("cover", day.game, "|", range.condition, "| chance", cover.breakdown.chance, "| cost", cover.quote.premium, "| hedgeMode", cover.quote.hedgeMode);
  const coverPermit = await permitTypedData(account.address, cover.quote.premium);
  const coverSig = await account.signTypedData({
    domain: coverPermit.typed.domain,
    types: { Permit: coverPermit.typed.types.Permit },
    primaryType: "Permit",
    message: { ...message, value: BigInt(coverPermit.typed.message.value), deadline: BigInt(coverPermit.typed.message.deadline) },
  });
  const coverCall = await promoCall(account.address, cover.quote, cover.signature, coverSig, coverPermit.deadline);
  console.log("OK: the cover's call would succeed. calldata bytes", (coverCall.callData.length - 2) / 2);
  // The pricer signed "the business gets paid": the same quote sent as a customer promo is not that quote.
  await refused(
    "a cover's quote sent as a customer promo",
    promoCall(account.address, { ...cover.quote, hedgeMode: false }, cover.signature, coverSig, coverPermit.deadline),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
