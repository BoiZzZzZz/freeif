// The QuickNode Stream's filter for FreeIf's PromoVault.
// Network: Arc Testnet. Dataset: logs. Destination: the keeper's webhook, POST /stream.
//
// For each block it keeps the logs the vault emitted whose first topic is one of the eleven events below,
// and returns them by name with the promo and the account they are about. A block with none returns null,
// and QuickNode delivers nothing for it. Amounts stay in `topics` and `data`: the keeper decodes them
// with the contract's ABI.
//
// This file is the filter as it runs: `pnpm stream` uploads it. test/stream.test.ts runs it against real
// blocks and checks every topic hash against the ABI.

var VAULT = "0x68a00243927f250dbcd9160b5d06623b62b2e06d";

// keccak256 of each event's signature. "promo": topic 1 is a promo id. "account": the topic that is an
// address, and what that address is.
var EVENTS = {
  "0xb18f1e7eab19c557908f28c779b3eb9edf00879529ddf8b63d61dcb95bfe5dc1": { name: "PromoCreated", promo: true, account: [2, "merchant"] },
  "0x18a8fa8961024e21a89d06558c29ab24681d5d9b3abe9673dfee792d7c711347": { name: "ClaimRegistered", promo: true, account: [2, "customer"] },
  "0xc77a991448f30157629c22a4bfca71eb99286a6eecf7f22187becc0a04babf26": { name: "Settled", promo: true },
  "0x2ae00ba9813199478b6f22f0c9b606daa70f8efc319c8d2fa6af63f66ea31763": { name: "Vetoed", promo: true },
  "0xf9421cfa03b075b989cc42e283bdc35ff4e65f56873643556e3b3c3df2479c0b": { name: "SettlementReset", promo: true },
  "0x43c39dc8d1811239e03412c74fc96a2b6128c45722a745f557f1d8df8779fc97": { name: "Finalized", promo: true },
  "0x83afdfb7961e3b7c4cf33a493ada023ff5fe8e48f3ba2ea8979bb8bcd925e56a": { name: "Voided", promo: true, account: [2, "merchant"] },
  "0x4f2d18324ee95128de091ed2adc501295479000ce4c2cec607aeb1b67e189e2f": { name: "Paid", promo: true, account: [2, "customer"] },
  "0x7087bc973091d569b9837529a7ff04489dbccaf60e855756b0aaa2705f0eba7d": { name: "PayoutFailed", promo: true, account: [2, "customer"] },
  "0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca": { name: "Deposited", promo: false, account: [1, "lp"] },
  "0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6": { name: "Withdrawn", promo: false, account: [1, "lp"] }
};

// The logs dataset arrives as arrays inside arrays: blocks, then transactions, then logs.
function collect(value, out) {
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) collect(value[i], out);
  } else if (value && typeof value === "object" && value.topics) {
    out.push(value);
  }
  return out;
}

function main(payload) {
  var logs = collect(payload.data, []);
  var events = [];
  for (var i = 0; i < logs.length; i++) {
    var log = logs[i];
    if (String(log.address).toLowerCase() !== VAULT) continue;
    var kind = EVENTS[log.topics[0]];
    if (!kind) continue;

    var event = {
      event: kind.name,
      promoId: kind.promo ? parseInt(log.topics[1], 16) : null,
      txHash: log.transactionHash,
      blockNumber: parseInt(log.blockNumber, 16),
      timestamp: parseInt(log.blockTimestamp, 16),
      logIndex: parseInt(log.logIndex, 16),
      address: log.address,
      topics: log.topics,
      data: log.data
    };
    // An indexed address is a 32-byte topic: the account is its last 20 bytes.
    if (kind.account) event[kind.account[1]] = "0x" + log.topics[kind.account[0]].slice(26);
    events.push(event);
  }
  if (events.length === 0) return null;

  var meta = payload.metadata || {};
  return {
    vault: VAULT,
    network: meta.network,
    streamId: meta.stream_id,
    blockRange: [meta.batch_start_range, meta.batch_end_range],
    events: events
  };
}
