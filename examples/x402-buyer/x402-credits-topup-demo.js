// Self-serve credits top-up demo: pay once with x402 and credits are minted to your
// account, with no operator grant. Targets the main runtime's /x402/credits/topup route,
// which is live when the runtime is in x402_facilitator mode with XYTARA_X402_ACCEPTS_JSON set.
//
// Usage:
//   node x402-credits-topup-demo.js                          # show the price and credits
//   BUYER_PRIVATE_KEY=0x... node x402-credits-topup-demo.js  # pay and receive credits
//
// Env:
//   TOPUP_URL          default https://xytara.onrender.com/x402/credits/topup
//   BUYER_PRIVATE_KEY  0x EVM key holding USDC on the advertised network
//   ACCOUNT_ID         optional; defaults to your wallet address on the runtime side

import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const TOPUP_URL = process.env.TOPUP_URL || "https://xytara.onrender.com/x402/credits/topup";
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const ACCOUNT_ID = process.env.ACCOUNT_ID || "";

const CHAINS = {
  "eip155:84532": { id: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", faucet: "https://faucet.circle.com (select Base Sepolia)" },
  "eip155:8453": { id: 8453, name: "Base", rpc: "https://mainnet.base.org", faucet: null }
};

function line() { console.log("-".repeat(72)); }

async function topup(headers = {}) {
  const res = await fetch(TOPUP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(ACCOUNT_ID ? { account_id: ACCOUNT_ID } : {})
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  console.log(`x402 credits top-up demo -> ${TOPUP_URL}\n`);

  line();
  console.log("Step 1  request a top-up without payment -> expect 402");
  const unpaid = await topup();
  if (unpaid.status !== 402) {
    console.error(`  expected 402, got ${unpaid.status}:`, JSON.stringify(unpaid.json).slice(0, 300));
    console.error("  the runtime may not be in x402_facilitator mode.");
    process.exit(1);
  }
  const req = unpaid.json.payment_required;
  const requirements = (req.accepts || [])[0];
  if (!requirements) { console.error("  no accepts advertised; set XYTARA_X402_ACCEPTS_JSON."); process.exit(1); }
  const chain = CHAINS[requirements.network];
  const human = (Number(requirements.amount) / 1e6).toFixed(6);
  console.log(`  price: ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}`);
  console.log(`  grants: ${req.credits_per_topup} credit units`);
  console.log(`  payTo: ${requirements.payTo}`);

  if (!PRIVATE_KEY) {
    line();
    console.log("No BUYER_PRIVATE_KEY set, stopping before payment.");
    console.log(`Fund a wallet with ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}${chain?.faucet ? ` (faucet: ${chain.faucet})` : ""}, set BUYER_PRIVATE_KEY, and run again.`);
    return;
  }
  if (!chain) { console.error(`  unsupported network ${requirements.network}`); process.exit(1); }

  line();
  console.log("Step 2  sign x402 exact USDC authorization (EIP-3009)");
  const account = privateKeyToAccount(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
  const wallet = createWalletClient({ account, transport: http(chain.rpc) });
  console.log("  buyer:", account.address);
  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value: BigInt(requirements.amount),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + (Number(requirements.maxTimeoutSeconds) || 60) + 30),
    nonce: toHex(randomBytes(32))
  };
  const signature = await wallet.signTypedData({
    account,
    domain: { name: requirements.extra?.name || "USDC", version: requirements.extra?.version || "2", chainId: chain.id, verifyingContract: requirements.asset },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
    ] },
    primaryType: "TransferWithAuthorization",
    message: authorization
  });
  const paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements,
    payload: { signature, authorization: {
      from: authorization.from, to: authorization.to, value: authorization.value.toString(),
      validAfter: "0", validBefore: authorization.validBefore.toString(), nonce: authorization.nonce
    } }
  }), "utf8").toString("base64");

  line();
  console.log("Step 3  pay and receive credits");
  const paid = await topup({ "payment-signature": paymentHeader });
  if (paid.status === 402) {
    console.log(`  still 402: ${paid.json?.reason || "not accepted"}${paid.json?.detail ? ` (${paid.json.detail})` : ""}`);
    console.log("  the signed payment reached the facilitator but did not settle (usually an unfunded wallet).");
    process.exit(2);
  }
  if (paid.status !== 200) { console.error(`  unexpected ${paid.status}:`, paid.json); process.exit(1); }
  console.log("  account:", paid.json.account_id);
  console.log("  credits available now:", paid.json.balance?.available_units);
  const settlementHeader = paid.headers.get("payment-response");
  if (settlementHeader) {
    const s = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8"));
    line();
    console.log("Settlement receipt (PAYMENT-RESPONSE):");
    console.log("  success:", s.success, "| tx:", s.transaction, "| network:", s.network);
  }
  line();
  console.log("Done: paid once, credits minted to the account, settled on-chain. No operator grant needed.");
}

main().catch((e) => { console.error("demo failed:", e?.message || e); process.exit(1); });
