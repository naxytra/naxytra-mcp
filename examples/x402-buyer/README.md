# x402 buyer demos

Standalone buyers that run the full machine-commerce loop against the live public
naxytra services: discover a tool, see the price, pay with USDC on Base, and receive
the result plus a settlement receipt and a signed delivery receipt.

A call is only settled after it succeeds — a failed, empty or invalid call is never
charged, and bad arguments are rejected before any payment is requested.

## Three demos

- `x402-buyer-demo.js` — a paid MCP `tools/call` on the MCP server, using the x402 MCP
  transport (payment in `params._meta["x402/payment"]`). Set `PAYMENT_TRANSPORT=header`
  to send it as a `PAYMENT-SIGNATURE` header instead, or `MCP_URL=.../mcp/http402` for the
  HTTP-402 variant used by fetch-wrapper clients.
- `x402-command-demo.js` — a paid `POST /x402/commands/execute` on the runtime, running an
  MCP tool through `task_ref: "adapter.mcp.invoke"`.
- `x402-credits-topup-demo.js` — buys reusable runtime credits with one x402 payment
  ($1.00 USDC on Base mainnet = 400 credits), stores the returned spend credential
  locally (`spend-credential.local.json`, git-ignored), and spends one call with
  `payment_preference: "credits_first"`.

All three sign the same gasless EIP-3009 USDC authorization.

## The flow

1. `tools/list` — free; lists the 17 tools.
2. `tools/call` with no payment — returns a payment-required tool result (`isError`,
   `structuredContent` = the x402 `PaymentRequired` with price, network, asset, `payTo`).
   The runtime routes answer with HTTP `402` and the same terms.
3. Sign an x402 `exact` USDC payment (EIP-3009 `transferWithAuthorization`) for exactly the
   advertised amount.
4. Call again with the payment — the server verifies it, runs the tool, settles only after
   success, and returns the result with `_meta["x402/payment-response"]` (and a
   `PAYMENT-RESPONSE` header) plus a signed delivery receipt.

## Run it

```bash
npm install

node x402-buyer-demo.js                               # see the price, no wallet (free)
BUYER_PRIVATE_KEY=0x<key> node x402-buyer-demo.js     # full paid tool call

node x402-command-demo.js                             # runtime price, no wallet
BUYER_PRIVATE_KEY=0x<key> node x402-command-demo.js   # paid MCP tool via the runtime

node x402-credits-topup-demo.js                       # top-up price + credits, no wallet
BUYER_PRIVATE_KEY=0x<key> node x402-credits-topup-demo.js   # buy credits, spend one call
```

> On PowerShell, set the key as its own statement:
> `$env:BUYER_PRIVATE_KEY = "0x<key>"; node x402-buyer-demo.js`

## Networks and money

- `x402-buyer-demo.js` prefers **Base Sepolia** by default ($0.001 in free test USDC from
  <https://faucet.circle.com>). Set `PREFER_NETWORK=eip155:8453` to pay on **Base mainnet**
  ($0.01 real USDC per call).
- The runtime demos pay on the network the runtime advertises; credits top-ups are Base
  mainnet only.
- No native gas token is needed: you sign an authorization and the facilitator broadcasts
  the transfer and pays gas.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_URL` | `https://xytara-mcp-executor.onrender.com/mcp` | the MCP endpoint (`.../mcp/http402` for HTTP 402) |
| `BUYER_PRIVATE_KEY` | *(unset)* | 0x EVM key holding USDC on the chosen network |
| `PREFER_NETWORK` | `eip155:84532` | `eip155:8453` for Base mainnet |
| `PAYMENT_TRANSPORT` | `meta` | `header` to send `PAYMENT-SIGNATURE` |
| `TOOL` / `ARGS` | `summarize` / sample | any tool from `tools/list` and its JSON arguments |
| `TASK_REF` | `adapter.mcp.invoke` | runtime task (`adapter.xoonya.invoke` for proof verification) |

## How to read the outcome

- **No key**: stops after the price and prints how to fund and retry.
- **Unfunded key**: the facilitator rejects the payment (insufficient balance) — the signed
  payment was well-formed; nothing is charged.
- **Funded key**: prints the tool result, the settlement transaction and the delivery receipt.
- Every runtime response carries an `X-Request-Id`; quote it if you ask for support.

## Notes

These examples talk only to the public naxytra endpoints. They use `viem` for EIP-712
signing and carry no server internals or credentials.
