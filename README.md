# naxytra — pay-per-call execution & settlement for agents

**naxytra lets an AI agent discover a tool, pay once with x402 (USDC on Base), and get a verifiable result with an on-chain settlement receipt — no account, no API key, no human in the loop.**

One endpoint, pay per call: **$0.01 USDC on Base mainnet** ($0.001 on Base Sepolia) for naxytra's own tools; open-network provider tools listed on the same endpoint are priced by each provider, **from $0.001** (1 credit with a spend key; one x402 payment is at least $0.005, Base mainnet only). Settlement is **gasless for the buyer** (x402 `exact` / EIP-3009), goes through the Coinbase CDP facilitator on Base, and happens **only after the call succeeds**. A $1.00 top-up on the runtime buys **400 reusable credits**.

> This repository is the public **integration front door** — how to connect, the pay-per-call flow, the tool catalog, and a runnable example buyer. The naxytra runtime, settlement engine, and tool implementations are a **hosted service**: you call them over open protocols (MCP · HTTP · x402 · A2A), you don't run them.

## Live endpoints

| Surface | URL |
| --- | --- |
| MCP server (streamable HTTP) | `https://mcp.naxytra.com/mcp` |
| MCP server card | `https://mcp.naxytra.com/server.json` |
| HTTP runtime | `https://api.naxytra.com` |
| Discovery index | `https://naxytra.com/v1/agent-discovery-index` |
| A2A agent card | `https://naxytra.com/.well-known/agent-card.json` |
| Website | `https://naxytra.com/agents` |

Networks: **Base mainnet** (`eip155:8453`) + **Base Sepolia** (`eip155:84532`), USDC.

## Quickstart — connect any MCP client

Point Claude Desktop, Cursor, or any MCP host at the endpoint:

```json
{
  "mcpServers": {
    "naxytra": { "url": "https://mcp.naxytra.com/mcp" }
  }
}
```

`tools/list` is free. An unpaid `tools/call` returns a payment-required tool result with the price (x402 MCP transport); pay and retry, and you get the result plus a settlement receipt and a signed delivery receipt. Fetch-style x402 clients can use `https://mcp.naxytra.com/mcp/http402` for a standard HTTP `402`.

## The pay-per-call flow

1. Agent calls a tool → gets a payment-required result (x402 `PaymentRequired`: price, `payTo`, asset, network). Bad arguments are rejected here, before any payment.
2. Agent signs **one gasless USDC authorization** (x402 `exact` / EIP-3009 `transferWithAuthorization`).
3. The Coinbase CDP facilitator verifies and settles it on Base.
4. Agent re-calls with the payment in `params._meta["x402/payment"]` (or a `PAYMENT-SIGNATURE` header) → the tool runs, the payment settles only on success, and the result comes back with `_meta["x402/payment-response"]` (settlement tx) and a signed delivery receipt (Ed25519 + ML-DSA-65).

Agents that make many calls can instead buy **reusable credits** on the runtime: one x402 payment of $1.00 USDC (Base mainnet) to `POST https://api.naxytra.com/x402/credits/topup` buys 400 credits (a typical call costs 3) and returns a spend credential for `payment_preference: "credits_first"` — still fully autonomous, no operator approval.

## Try it in 60 seconds (no download)

```bash
# free: list the tools
curl -s https://mcp.naxytra.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# calling a tool without payment returns a payment-required result with the price
curl -s https://mcp.naxytra.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"summarize","arguments":{"text":"hello"}}}'
```

## Runnable example buyer

[`examples/x402-buyer`](examples/x402-buyer) is a standalone, `viem`-only buyer that walks the whole loop against the live endpoint — discover a tool, get priced, sign the gasless USDC authorization, settle, and print the result plus the settlement tx hash. Run it with **no wallet** to see the price and the payment handshake for free. It defaults to **Base Sepolia** ($0.001 in free test USDC); set `PREFER_NETWORK=eip155:8453` to pay **real USDC on Base mainnet** ($0.01 per call). The folder also has runtime and credits demos.

## Tool catalog — 17 tools, pay-per-call

**Text & data:** `summarize` · `html.to-text` · `text.chunk` · `text.extract` · `json.validate` · `reply.draft` · `catalog` · `zones.lookup`

**x402 & EVM-native:** `x402.decode` · `x402.verify-receipt` · `keccak256` · `address.validate` · `abi.encode` · `abi.decode` · `merkle.verify` · `eip712.hash`

The live catalog with full input/output schemas is always at [`tools/list`](https://mcp.naxytra.com/mcp) and [`/server.json`](https://mcp.naxytra.com/server.json).

## Anchored attestations: verifiable offline, no account

Signed attestations from `x402.verify-receipt` and `tx.status` can be anchored in time with chronology-protocol, an open timestamping protocol published by machine-native: https://github.com/machine-native/chronology-protocol (see `VERIFY.md`). The protocol is open and anyone can run the same anchoring from that repository. naxytra uses it; it is not exclusive to naxytra.

What an anchor shows, strongest part first:

- **Public Bitcoin.** Each published epoch is timestamped with OpenTimestamps. Its proofs are attested in public Bitcoin blocks that neither naxytra nor machine-native controls. This shows the attestation existed no later than those blocks.
- **Laboratory chain.** Each epoch is also ordered in a difficulty-1 laboratory chain that a single operator mines. On its own, that shows only ordering relative to that operator's work, which is why we always pair it with the Bitcoin proofs above.

How it works: the binding tag is placed inside the attestation before it is signed (`bindings: [{scheme: "ctp/1", system_id, tag}]`). naxytra submits only the attestation's SHA-256 digest (of its RFC 8785 form). It never submits who asked, what, or for how much. All times are UTC.

Latency: the operator batches anchoring into epochs, currently monthly or when a batch is ready. The Bitcoin attestation usually lands within a day of stamping. There is no SLA, and anchoring is neither per-transaction nor instant. Status of any attestation: `GET https://api.naxytra.com/v1/anchoring/<attestation_id>` (anchored in epoch N / queued for the next epoch / not bound). Anchoring costs nothing extra: the attestation price ($0.02 or 6 credits) covers it.

Check it yourself. You need Python 3.10+ and OpenSSL 3.5+; no account, and no trust in naxytra or machine-native:

1. **Open the record.** Fetch the attestation by id (`https://mcp.naxytra.com/attestations/<id>`, or `https://api.naxytra.com/v1/delegation-log/checkpoints/<id>` for a delegation-log checkpoint). SHA-256 its RFC 8785 form. The digest must equal the one bound in the epoch.
2. **Verify the bundle offline.** `python scripts/verify_sandwich.py vectors/valid/<bundle>.cbor` should print a passing verdict: `SANDWICH_PASS`, or `SANDWICH_PASS_NO_TIME_CONSENSUS` when the time witnesses did not agree on a single instant. Either way the record existed after laboratory block B0 and no later than laboratory block C; with `NO_TIME_CONSENSUS` the bundle gives no wall-clock time.
3. **Check public Bitcoin (needs network).** `python scripts/confirm_attestations.py` confirms each OpenTimestamps attestation against a public explorer.

Anchored so far:

- Epoch 10: two `tx.status` attestations (`att_7901a5f0869e`, `att_9ba842d872c4`); bundle `naxytra-binding-bundle.cbor`; laboratory block 1365; OpenTimestamps proofs attested in Bitcoin blocks 972765–972808.
- Epoch 11: the first delegation-log checkpoint (`att_61682b456a1d`); bundle `naxytra-delegation-binding-bundle.cbor`; laboratory block 1368; proofs attested in Bitcoin blocks 972955–973014.
- Epoch 12: one `tx.status` attestation; bundle `naxytra-attestation-binding-bundle.cbor`; laboratory block 1703; verdict `SANDWICH_PASS_NO_TIME_CONSENSUS` (it existed after laboratory block 1570 and no later than 1703; no wall-clock time). Bitcoin timestamp pending: its OpenTimestamps proofs are not yet attested.
- Later weekly delegation-log checkpoints are archived as issued and go into the next monthly epoch.
- Other attestations issued so far were not submitted and are not anchored.

## Proven on Base mainnet (real USDC)

- Paid MCP tool call: [`0x3c63caed…1529bf9231`](https://basescan.org/tx/0x3c63caed66cc4ee2f545589efe3a8ca34fd1099143d5593aa9f7351529bf9231)
- Runtime settlement: [`0x7dc65377…92c0581f`](https://basescan.org/tx/0x7dc653777d18fe18b63f97783524b6d50c724901a5a21c15eca7aaf192c0581f)

## Find naxytra in the ecosystem

- **MCP Registry:** `com.naxytra/xytara-mcp-executor`
- **Glama:** <https://glama.ai/mcp/connectors/com.naxytra/xytara-mcp-executor>
- **Smithery:** <https://smithery.ai/servers/naxytra/xytara-mcp-executor>
- **x402scan:** <https://www.x402scan.com/server/0bb9475c-0e35-4621-ac88-57696a6525f7>

## License

The example code and documentation in this repository are released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)). The naxytra runtime, settlement engine, breadth catalog, and tool implementations are proprietary and hosted — they are **not** included here. This repo is the integration surface, not the product.
