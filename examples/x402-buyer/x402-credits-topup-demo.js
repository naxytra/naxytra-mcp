// Self-serve credits top-up demo: pay once with x402, credits are minted to your account and a
// spend credential is issued, then spend those credits on a command with "credits_first".
// Targets the main runtime's /x402/credits/topup route (live when the runtime is in
// x402_facilitator mode). A top-up costs 100x the per-call price ($1.00 on Base mainnet; testnet
// top-ups are disabled by default) and grants paid/2500 credits (400 for $1.00).
//
// Usage:
//   node x402-credits-topup-demo.js                          # show the top-up price and credits
//   BUYER_PRIVATE_KEY=0x... node x402-credits-topup-demo.js  # pay, receive credits + credential, spend once
//   SPEND_ONLY=1 node x402-credits-topup-demo.js             # spend with the stored credential, no payment
//
// Env:
//   TOPUP_URL          default https://xytara.onrender.com/x402/credits/topup
//   EXECUTE_URL        default https://xytara.onrender.com/x402/commands/execute
//   BUYER_PRIVATE_KEY  0x EVM key holding USDC on the advertised network (no ETH needed)
//   PREFER_NETWORK     default eip155:8453 (top-ups are mainnet-only by default)
//   CREDENTIAL_FILE    where the spend credential is stored (default spend-credential.local.json,
//                      git-ignored). The bearer token is shown only once by the runtime and is
//                      never printed in full here.
//   ACCOUNT_ID         optional; credits for any other account than your paying address are a
//                      gift: granted, but no spend credential is issued.
//   TOOL / ARGS        the command spent with credits (default keccak256 {"data":"naxytra"})

import { createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TOPUP_URL = process.env.TOPUP_URL || "https://xytara.onrender.com/x402/credits/topup";
const EXECUTE_URL = process.env.EXECUTE_URL || new URL("/x402/commands/execute", TOPUP_URL).toString();
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const ACCOUNT_ID = process.env.ACCOUNT_ID || "";
const PREFER_NETWORK = process.env.PREFER_NETWORK || "eip155:8453";
const CREDENTIAL_FILE = process.env.CREDENTIAL_FILE || "spend-credential.local.json";
const SPEND_ONLY = /^(1|true|yes)$/i.test(process.env.SPEND_ONLY || "");
const TOOL = process.env.TOOL || "keccak256";
const ARGS = process.env.ARGS ? JSON.parse(process.env.ARGS) : { data: "naxytra" };

const CHAINS = {
  "eip155:84532": { id: 84532, name: "Base Sepolia", rpc: "https://sepolia.base.org", faucet: "https://faucet.circle.com (select Base Sepolia)" },
  "eip155:8453": { id: 8453, name: "Base", rpc: "https://mainnet.base.org", faucet: null }
};

function line() { console.log("-".repeat(72)); }
function usd(atomic) { return `$${(Number(atomic) / 1e6).toFixed(Number(atomic) >= 10000 ? 2 : 6)}`; }
function mask(token) { const t = String(token || ""); return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)` : "(hidden)"; }

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

function storeCredential(credential) {
  writeFileSync(CREDENTIAL_FILE, JSON.stringify({ ...credential, stored_at: new Date().toISOString(), runtime: new URL(TOPUP_URL).origin }, null, 2), { mode: 0o600 });
}

function loadCredential() {
  if (!existsSync(CREDENTIAL_FILE)) return null;
  try { return JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8")); } catch { return null; }
}

// Spend credits on one command: payment_preference "credits_first" + the spend credential's
// bearer token (a bare account_id is refused with 401 credit_spend_credential_required).
async function spendWithCredits(credential) {
  line();
  console.log(`Spend  ${TOOL} with credits_first -> ${EXECUTE_URL}`);
  const spent = await postJson(EXECUTE_URL, {
    account_id: credential.account_id,
    command: "mcp tool invoke",
    task_ref: "adapter.mcp.invoke",
    payment_preference: "credits_first",
    body: { tool_name: TOOL, arguments: ARGS }
  }, { authorization: `Bearer ${credential.bearer_token}` });
  if (spent.status === 401) {
    console.log(`  401 ${spent.json?.reason || "unauthorized"}: the credential was refused (revoked, expired, or for another account).`);
    process.exit(3);
  }
  if (spent.status === 402) {
    console.log(`  402: ${spent.json?.reason || "payment required"} — the account has no credits left (top up again) or credits_first was not honored.`);
    process.exit(3);
  }
  if (spent.status !== 200) { console.error(`  unexpected ${spent.status}:`, JSON.stringify(spent.json).slice(0, 400)); process.exit(1); }
  const deliv = spent.json?.command?.deliverables?.[0];
  console.log("  paid with:", spent.json?.transaction?.payment?.verification_mode || spent.json?.payment_mode || "credits");
  console.log("  output_payload:", JSON.stringify(deliv?.output_payload ?? null).slice(0, 300));
  const balance = spent.json?.balance || spent.json?.credit_balance;
  if (balance) console.log("  credits left:", balance.available_units ?? JSON.stringify(balance));
}

async function main() {
  console.log(`x402 credits top-up demo -> ${TOPUP_URL}\n`);

  if (SPEND_ONLY) {
    const stored = loadCredential();
    if (!stored || !stored.bearer_token) { console.error(`No stored spend credential in ${CREDENTIAL_FILE}; run a paid top-up first.`); process.exit(1); }
    console.log(`Using stored credential ${stored.credential_id} for ${stored.account_id} (token ${mask(stored.bearer_token)})`);
    await spendWithCredits(stored);
    return;
  }

  line();
  console.log("Step 1  request a top-up without payment -> expect 402");
  const unpaid = await postJson(TOPUP_URL, ACCOUNT_ID ? { account_id: ACCOUNT_ID } : {});
  if (unpaid.status !== 402) {
    console.error(`  expected 402, got ${unpaid.status}:`, JSON.stringify(unpaid.json).slice(0, 300));
    console.error("  the runtime may not be in x402_facilitator mode, or no mainnet top-up option is configured.");
    process.exit(1);
  }
  const req = unpaid.json.payment_required || {};
  const options = Array.isArray(req.topup_options) ? req.topup_options : [];
  for (const option of options) {
    console.log(`  top-up option: ${usd(option.amount)} USDC on ${CHAINS[option.network]?.name || option.network} -> ${option.credits} credits (1 credit = ${usd(option.credit_unit_price_atomic)})`);
  }
  if (req.spend_with) console.log(`  spend with: ${req.spend_with}`);
  const requirements = (req.accepts || []).find((a) => a.network === PREFER_NETWORK) || (req.accepts || [])[0];
  if (!requirements) { console.error("  no accepts advertised."); process.exit(1); }
  const chain = CHAINS[requirements.network];
  const chosen = options.find((o) => o.network === requirements.network);
  console.log(`  paying: ${usd(requirements.amount)} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network} -> ${requirements.payTo}${chosen ? ` for ${chosen.credits} credits` : ""}`);

  if (!PRIVATE_KEY) {
    line();
    console.log("No BUYER_PRIVATE_KEY set, stopping before payment.");
    console.log(`Fund a wallet with ${usd(requirements.amount)} ${requirements.extra?.name || "USDC"} on ${chain?.name || requirements.network}${chain?.faucet ? ` (faucet: ${chain.faucet})` : ""}, set BUYER_PRIVATE_KEY, and run again.`);
    return;
  }
  if (!chain) { console.error(`  unsupported network ${requirements.network}`); process.exit(1); }

  line();
  console.log("Step 2  sign x402 exact USDC authorization (EIP-3009)");
  const account = privateKeyToAccount(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
  const wallet = createWalletClient({ account, transport: http(chain.rpc) });
  console.log("  buyer:", account.address);
  if (ACCOUNT_ID && ACCOUNT_ID.toLowerCase() !== account.address.toLowerCase()) {
    console.log(`  note: crediting ${ACCOUNT_ID} (not your address): a gift, no spend credential will be issued.`);
  }
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
  const paid = await postJson(TOPUP_URL, ACCOUNT_ID ? { account_id: ACCOUNT_ID } : {}, { "payment-signature": paymentHeader });
  if (paid.status === 402) {
    console.log(`  still 402: ${paid.json?.reason || "not accepted"}${paid.json?.detail ? ` (${paid.json.detail})` : ""}`);
    console.log("  the signed payment reached the facilitator but did not settle (usually an unfunded wallet).");
    process.exit(2);
  }
  if (paid.status !== 200) { console.error(`  unexpected ${paid.status}:`, paid.json); process.exit(1); }
  console.log("  account:", paid.json.account_id);
  console.log("  credits granted:", paid.json.credit_grant?.units ?? "(see balance)");
  console.log("  credits available now:", paid.json.balance?.available_units);
  const settlementHeader = paid.headers.get("payment-response");
  if (settlementHeader) {
    const s = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8"));
    console.log("  settlement:", s.success, "| tx:", s.transaction, "| network:", s.network);
  }

  const credential = paid.json.spend_credential;
  if (!credential || !credential.bearer_token) {
    line();
    console.log(`No spend credential returned: ${paid.json.spend_credential_note || "credits went to an account other than the paying address"}.`);
    return;
  }
  storeCredential(credential);
  line();
  console.log("Spend credential issued (shown once by the runtime):");
  console.log(`  credential_id: ${credential.credential_id}`);
  console.log(`  account_id:    ${credential.account_id}`);
  console.log(`  bearer_token:  ${mask(credential.bearer_token)} -> stored in ${CREDENTIAL_FILE} (keep it secret; anyone holding it can spend these credits)`);

  await spendWithCredits(credential);
  line();
  console.log("Done: paid once, credits minted, spend credential issued, and one command paid from credits.");
}

main().catch((e) => { console.error("demo failed:", e?.message || e); process.exit(1); });
