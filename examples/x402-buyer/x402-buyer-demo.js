// x402 buyer demo for the public xytara MCP executor (x402 MCP transport).
//
// It walks the full machine-commerce loop against the live server:
//   1. list tools        (free)
//   2. call a tool        -> a payment-required tool result (isError + PaymentRequired), HTTP 200
//   3. sign an x402 "exact" USDC payment (EIP-3009 transferWithAuthorization)
//   4. call the tool again with the payment in params._meta["x402/payment"]
//      -> the tool result + result._meta["x402/payment-response"] + a signed delivery receipt
//
// Steps 1-3 run with any key (even an unfunded throwaway) and prove the payment
// pipeline reaches the facilitator. Step 4 only settles when the signing wallet
// actually holds USDC on the chosen network. Failed calls are never charged.
//
// Usage:
//   npm install
//   node x402-buyer-demo.js                     # steps 1-2 only (no wallet)
//   BUYER_PRIVATE_KEY=0x... node x402-buyer-demo.js   # full paid call
//
// Env:
//   MCP_URL              default https://xytara-mcp-executor.onrender.com/mcp
//                        (use .../mcp/http402 for the HTTP-402 variant)
//   BUYER_PRIVATE_KEY    0x-prefixed EVM private key that holds USDC on the chosen network
//   PREFER_NETWORK       default eip155:84532 (Base Sepolia, $0.001 test USDC); eip155:8453 = mainnet ($0.01)
//   PAYMENT_TRANSPORT    meta (default: params._meta["x402/payment"]) or header (PAYMENT-SIGNATURE)
//   TOOL                 default "summarize"
//   TEXT                 default a sample sentence to summarize
//   ARGS                 optional JSON arguments overriding the defaults

import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const MCP_URL = process.env.MCP_URL || "https://xytara-mcp-executor.onrender.com/mcp";
const TOOL = process.env.TOOL || "summarize";
const TEXT = process.env.TEXT || "Machine commerce means an agent can discover a tool, pay for one call, and get a verifiable result. This demo pays the live xytara MCP executor with USDC on Base.";
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const PREFER_NETWORK = process.env.PREFER_NETWORK || "eip155:84532";
const PAYMENT_TRANSPORT = (process.env.PAYMENT_TRANSPORT || "meta").toLowerCase();

const CHAINS = {
  "eip155:84532": { id: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", faucet: "https://faucet.circle.com (select Base Sepolia)" },
  "eip155:8453": { id: 8453, name: "Base", rpc: "https://mainnet.base.org", faucet: null }
};

function b64json(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function line() {
  console.log("-".repeat(72));
}
function toolArguments() {
  if (process.env.ARGS) return JSON.parse(process.env.ARGS);
  if (TOOL === "summarize" || TOOL === "reply.draft" || TOOL === "text.extract" || TOOL === "text.chunk") return { text: TEXT };
  if (TOOL === "zones.lookup") return { hostname: "naxytra.com" };
  if (TOOL === "json.validate") return { payload: { ok: true }, schema: { type: "object", required: ["ok"] } };
  if (TOOL === "keccak256") return { data: TEXT };
  if (TOOL === "catalog") return {};
  return { text: TEXT };
}

async function rpc(method, params, headers = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// The PaymentRequired object: spec-native tool result (structuredContent, else content[0].text),
// the HTTP-402 variant's JSON-RPC error.data, or the base64 PAYMENT-REQUIRED header.
function extractPaymentRequired(response) {
  const result = response.json && response.json.result;
  if (result && result.isError) {
    if (result.structuredContent && Array.isArray(result.structuredContent.accepts)) return result.structuredContent;
    try {
      const parsed = JSON.parse(result.content?.[0]?.text || "");
      if (Array.isArray(parsed.accepts)) return parsed;
    } catch { /* not a payment-required result */ }
  }
  const error = response.json && response.json.error;
  if (error && error.data && Array.isArray(error.data.accepts)) return error.data;
  const header = response.headers.get("payment-required");
  if (header) {
    try { return JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { /* garbled */ }
  }
  return null;
}

async function main() {
  console.log(`x402 buyer demo -> ${MCP_URL}\n`);

  // ---- Step 1: free discovery ----
  line();
  console.log("Step 1  tools/list (free)");
  const list = await rpc("tools/list", {});
  if (list.status !== 200 || !list.json?.result?.tools) {
    console.error("  unexpected response:", list.status, list.json);
    process.exit(1);
  }
  console.log("  tools:", list.json.result.tools.map((t) => t.name).join(", "));

  // ---- Step 2: unpaid call -> payment required ----
  line();
  console.log(`Step 2  tools/call "${TOOL}" without payment -> expect a payment-required result`);
  const unpaid = await rpc("tools/call", { name: TOOL, arguments: toolArguments() });
  if (unpaid.json?.error && !extractPaymentRequired(unpaid)) {
    console.error(`  the call was rejected before payment (${unpaid.json.error.code}): ${unpaid.json.error.message}`);
    process.exit(1);
  }
  if (unpaid.json?.result && !unpaid.json.result.isError) {
    console.log("  the tool answered without payment (free tool or public mode):");
    console.log("   ", JSON.stringify(unpaid.json.result.structuredContent).slice(0, 400));
    return;
  }
  const challenge = extractPaymentRequired(unpaid);
  if (!challenge) {
    const sc = unpaid.json?.result?.structuredContent;
    console.error(`  no payment challenge (HTTP ${unpaid.status}):`, sc ? JSON.stringify(sc).slice(0, 400) : unpaid.json);
    process.exit(1);
  }
  console.log(`  HTTP ${unpaid.status} — ${challenge.error || "payment required"}`);
  const requirements = (challenge.accepts || []).find((a) => a.network === PREFER_NETWORK) || (challenge.accepts || [])[0];
  if (!requirements) {
    console.error("  the challenge carried no accepts entry:", challenge);
    process.exit(1);
  }
  const chain = CHAINS[requirements.network];
  const human = (Number(requirements.amount) / 1e6).toFixed(6);
  console.log(`  price: ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}`);
  console.log(`  payTo: ${requirements.payTo}`);
  console.log(`  asset: ${requirements.asset}`);

  if (!PRIVATE_KEY) {
    line();
    console.log("No BUYER_PRIVATE_KEY set, stopping before payment.");
    console.log("To make the paid call:");
    console.log(`  1. Fund any EVM wallet with at least ${human} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}${chain?.faucet ? ` (testnet faucet: ${chain.faucet})` : ""}.`);
    console.log(`     No native gas token is needed: the payment is gasless, the facilitator pays gas.`);
    console.log(`  2. Set BUYER_PRIVATE_KEY to that wallet's key and run this again.`);
    console.log(`     PowerShell:  $env:BUYER_PRIVATE_KEY = "0x<key>"; node x402-buyer-demo.js`);
    console.log(`     bash:        BUYER_PRIVATE_KEY=0x<key> node x402-buyer-demo.js`);
    return;
  }
  if (!chain) {
    console.error(`  unsupported network ${requirements.network}; add it to CHAINS first.`);
    process.exit(1);
  }

  // ---- Step 3: sign the x402 "exact" USDC payment (EIP-3009) ----
  line();
  console.log("Step 3  sign x402 exact USDC authorization (EIP-3009)");
  const account = privateKeyToAccount(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
  const wallet = createWalletClient({ account, transport: http(chain.rpc) });
  console.log("  buyer:", account.address);

  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (Number(requirements.maxTimeoutSeconds) || 300));
  const nonce = toHex(randomBytes(32));
  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value: BigInt(requirements.amount),
    validAfter,
    validBefore,
    nonce
  };
  const signature = await wallet.signTypedData({
    account,
    domain: {
      name: requirements.extra?.name || "USDC",
      version: requirements.extra?.version || "2",
      chainId: chain.id,
      verifyingContract: requirements.asset
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
    },
    primaryType: "TransferWithAuthorization",
    message: authorization
  });
  console.log("  signature:", signature.slice(0, 22) + "…");

  const paymentPayload = {
    x402Version: 2,
    resource: challenge.resource,
    accepted: requirements,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce
      }
    }
  };

  // ---- Step 4: paid call ----
  line();
  const viaHeader = PAYMENT_TRANSPORT === "header" || MCP_URL.endsWith("/http402");
  console.log(`Step 4  tools/call "${TOOL}" with payment (${viaHeader ? "PAYMENT-SIGNATURE header" : "params._meta[\"x402/payment\"]"})`);
  const params = { name: TOOL, arguments: toolArguments(), ...(viaHeader ? {} : { _meta: { "x402/payment": paymentPayload } }) };
  const paid = await rpc("tools/call", params, viaHeader ? { "payment-signature": b64json(paymentPayload) } : {});
  const rejected = extractPaymentRequired(paid);
  if (rejected) {
    console.log(`  not paid: ${rejected.reason || "payment not accepted"}${rejected.facilitatorReason ? ` / ${rejected.facilitatorReason}` : ""}${rejected.errorDetail ? ` (${rejected.errorDetail})` : ""}`);
    if (rejected.hint) console.log(`  hint: ${rejected.hint}`);
    console.log("  you were not charged. The most common cause is the wallet not holding enough USDC on this network.");
    process.exit(2);
  }
  if (paid.status !== 200 || !paid.json?.result) {
    console.error(`  unexpected ${paid.status}:`, paid.json);
    process.exit(1);
  }
  if (paid.json.result.isError) {
    console.log("  the tool failed (not charged):", JSON.stringify(paid.json.result.structuredContent).slice(0, 400));
    process.exit(1);
  }
  console.log("  tool result:");
  console.log("   ", JSON.stringify(paid.json.result.structuredContent, null, 2).replace(/\n/g, "\n    "));
  const meta = paid.json.result._meta || {};
  let settlement = meta["x402/payment-response"] || null;
  const settlementHeader = paid.headers.get("payment-response");
  if (!settlement && settlementHeader) {
    try { settlement = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8")); } catch { /* garbled */ }
  }
  if (settlement) {
    line();
    console.log("Settlement (result._meta[\"x402/payment-response\"]):");
    console.log("  success:", settlement.success);
    if (settlement.transaction) console.log("  tx:", settlement.transaction);
    if (settlement.network) console.log("  network:", settlement.network);
    if (settlement.payer) console.log("  payer:", settlement.payer);
    if (settlement.recovered) console.log("  recovered:", settlement.recovered);
  }
  const receipt = meta["naxytra.com/delivery-receipt"];
  if (receipt) {
    console.log("Delivery receipt:", receipt.v, "| signed:", (receipt.signing?.suite || []).join(" + ") || "unsigned", "| output_sha256:", receipt.delivery?.output_sha256?.slice(0, 16) + "…");
  }
  line();
  console.log("Done: discovered, paid, executed, and received a settlement receipt.");
}

main().catch((error) => {
  console.error("demo failed:", error?.message || error);
  process.exit(1);
});
