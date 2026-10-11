// x402 buyer demo for the main xytara runtime's /x402/commands/execute route.
//
// Same trustless loop as x402-buyer-demo.js, but against the general command runtime
// instead of the MCP tool server:
//   1. call a command with no payment      -> 402 with the advertised price
//   2. sign a gasless x402 USDC payment (EIP-3009)
//   3. call again with the payment          -> 200 + result + a settlement receipt
//
// The runtime must be running in x402_facilitator mode with XYTARA_X402_ACCEPTS_JSON set.
//
// Usage:
//   node x402-command-demo.js                          # show the price (no wallet)
//   BUYER_PRIVATE_KEY=0x... node x402-command-demo.js  # full paid call
//
// Env:
//   X402_URL           default https://xytara.onrender.com/x402/commands/execute
//   BUYER_PRIVATE_KEY  0x EVM key holding USDC on the advertised network
//   TASK_REF           default trust.verify
//   COMMAND            default a sample command label

import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const X402_URL = process.env.X402_URL || "https://xytara.onrender.com/x402/commands/execute";
const TASK_REF = process.env.TASK_REF || "trust.verify";
const COMMAND = process.env.COMMAND || "x402 command demo";
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";

const CHAINS = {
  "eip155:84532": { id: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", faucet: "https://faucet.circle.com (select Base Sepolia)" },
  "eip155:8453": { id: 8453, name: "Base", rpc: "https://mainnet.base.org", faucet: null }
};

function line() { console.log("-".repeat(72)); }

async function execute(headers = {}) {
  const res = await fetch(X402_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ account_id: "acct_x402_demo", command: COMMAND, task_ref: TASK_REF, body: { subject_id: "demo-1" } })
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  console.log(`x402 command demo -> ${X402_URL}\n`);

  line();
  console.log("Step 1  execute without payment -> expect 402");
  const unpaid = await execute();
  if (unpaid.status !== 402) {
    console.error(`  expected 402, got ${unpaid.status}:`, JSON.stringify(unpaid.json).slice(0, 300));
    console.error("  the runtime may not be in x402_facilitator mode.");
    process.exit(1);
  }
  const requirements = unpaid.json && unpaid.json.payment_required && (unpaid.json.payment_required.accepts || [])[0];
  if (!requirements) {
    console.error("  the 402 advertised no accepts; set XYTARA_X402_ACCEPTS_JSON on the runtime.");
    process.exit(1);
  }
  const chain = CHAINS[requirements.network];
  const human = (Number(requirements.amount) / 1e6).toFixed(6);
  console.log(`  price: ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}`);
  console.log(`  payTo: ${requirements.payTo}`);

  if (!PRIVATE_KEY) {
    line();
    console.log("No BUYER_PRIVATE_KEY set, stopping before payment.");
    console.log(`Fund a wallet with ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}${chain?.faucet ? ` (faucet: ${chain.faucet})` : ""},`);
    console.log("then set BUYER_PRIVATE_KEY and run again. No native gas token is needed.");
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
  console.log("Step 3  execute with payment");
  const paid = await execute({ "payment-signature": paymentHeader });
  if (paid.status === 402) {
    console.log(`  still 402: ${paid.json?.reason || "not accepted"}${paid.json?.detail ? ` (${paid.json.detail})` : ""}`);
    console.log("  the signed payment reached the facilitator but did not settle (usually an unfunded wallet).");
    process.exit(2);
  }
  if (paid.status !== 200) { console.error(`  unexpected ${paid.status}:`, paid.json); process.exit(1); }
  console.log("  transaction:", paid.json?.transaction?.transaction_id, "| status:", paid.json?.transaction?.status);
  console.log("  receipt:", paid.json?.receipt?.receipt_id);
  const settlementHeader = paid.headers.get("payment-response");
  if (settlementHeader) {
    const s = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8"));
    line();
    console.log("Settlement receipt (PAYMENT-RESPONSE):");
    console.log("  success:", s.success, "| tx:", s.transaction, "| network:", s.network);
  }
  line();
  console.log("Done: priced, paid, executed, and received a settlement receipt on the runtime.");
}

main().catch((e) => { console.error("demo failed:", e?.message || e); process.exit(1); });
