// x402 buyer demo for the public xytara MCP executor.
//
// It walks the full machine-commerce loop against the live server:
//   1. list tools        (free)
//   2. call a tool        -> 402 Payment Required with the price
//   3. sign an x402 "exact" USDC payment (EIP-3009 transferWithAuthorization)
//   4. call the tool again with the payment -> 200 + the tool result + a settlement receipt
//
// Steps 1-3 run with any key (even an unfunded throwaway) and prove the payment
// pipeline reaches the facilitator. Step 4 only settles when the signing wallet
// actually holds USDC on the advertised network.
//
// Usage:
//   npm install
//   node x402-buyer-demo.js                     # steps 1-2 only (no wallet)
//   BUYER_PRIVATE_KEY=0x... node x402-buyer-demo.js   # full paid call
//
// Env:
//   MCP_URL              default https://xytara-mcp-executor.onrender.com/mcp
//   BUYER_PRIVATE_KEY    0x-prefixed EVM private key that holds USDC on the
//                        advertised network. NOTE: the live endpoint currently
//                        prices in REAL USDC on Base mainnet — a paid run spends
//                        real money. The no-key run is free.
//   TOOL                 default "summarize"
//   TEXT                 default a sample sentence to summarize

import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const MCP_URL = process.env.MCP_URL || "https://xytara-mcp-executor.onrender.com/mcp";
const TOOL = process.env.TOOL || "summarize";
const TEXT = process.env.TEXT || "Machine commerce means an agent can discover a tool, pay for one call, and get a verifiable result. This demo pays the live xytara MCP executor per call with USDC on Base.";
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";

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
  if (TOOL === "summarize" || TOOL === "reply.draft") return { text: TEXT };
  if (TOOL === "zones.lookup") return { hostname: "naxytra.com" };
  if (TOOL === "json.validate") return { payload: { ok: true } };
  if (TOOL === "catalog") return {};
  return { text: TEXT };
}

async function rpc(method, params, headers = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
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

  // ---- Step 2: unpaid call -> 402 challenge ----
  line();
  console.log(`Step 2  tools/call "${TOOL}" without payment -> expect 402`);
  const unpaid = await rpc("tools/call", { name: TOOL, arguments: toolArguments() });
  if (unpaid.status !== 402) {
    console.error(`  expected 402, got ${unpaid.status}:`, unpaid.json);
    process.exit(1);
  }
  const challenge = unpaid.json;
  const requirements = (challenge.accepts || [])[0];
  if (!requirements) {
    console.error("  402 carried no accepts entry:", challenge);
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
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (Number(requirements.maxTimeoutSeconds) || 60) + 30);
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

  const paymentHeader = b64json({
    x402Version: 2,
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
  });

  // ---- Step 4: paid call ----
  line();
  console.log(`Step 4  tools/call "${TOOL}" with payment`);
  const paid = await rpc("tools/call", { name: TOOL, arguments: toolArguments() }, { "payment-signature": paymentHeader });
  if (paid.status === 402) {
    console.log(`  still 402: ${paid.json?.error || "payment not accepted"}${paid.json?.errorDetail ? ` (${paid.json.errorDetail})` : ""}`);
    console.log("  this means the signed payment reached the facilitator but did not settle.");
    console.log("  the most common cause is the wallet not holding enough USDC on this network.");
    process.exit(2);
  }
  if (paid.status !== 200) {
    console.error(`  unexpected ${paid.status}:`, paid.json);
    process.exit(1);
  }
  console.log("  tool result:");
  console.log("   ", JSON.stringify(paid.json?.result?.structuredContent || paid.json?.result, null, 2).replace(/\n/g, "\n    "));
  const settlementHeader = paid.headers.get("payment-response");
  if (settlementHeader) {
    try {
      const settlement = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8"));
      line();
      console.log("Settlement receipt (PAYMENT-RESPONSE):");
      console.log("  success:", settlement.success);
      if (settlement.transaction) console.log("  tx:", settlement.transaction);
      if (settlement.network) console.log("  network:", settlement.network);
      if (settlement.payer) console.log("  payer:", settlement.payer);
    } catch {
      console.log("  PAYMENT-RESPONSE header present but could not be decoded.");
    }
  }
  line();
  console.log("Done: discovered, paid, executed, and received a settlement receipt.");
}

main().catch((error) => {
  console.error("demo failed:", error?.message || error);
  process.exit(1);
});
