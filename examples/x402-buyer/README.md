# x402 buyer demo

A standalone buyer that runs the full machine-commerce loop against the live
public `xytara` MCP executor: discover a tool, get priced, pay with USDC on Base,
and receive the tool result plus an on-chain settlement receipt.

This is the shortest honest proof that the stack does what it claims: an agent
with a funded wallet can pay for a single tool call and get a verifiable result.

## Three demos

- `x402-buyer-demo.js` — a paid MCP `tools/call` against the MCP executor.
- `x402-command-demo.js` — a paid `/x402/commands/execute` against the main runtime.
- `x402-credits-topup-demo.js` — a single x402 payment to `/x402/credits/topup` that mints spendable runtime credits to your account, with no operator grant.

The first two pay per call; the third buys reusable credit. All sign the same gasless EIP-3009 USDC authorization.

## What it does

1. `tools/list` — free, lists the available tools (17).
2. `tools/call` with no payment — returns `402 Payment Required` with the price,
   the receiving address, and the token to pay in.
3. Signs an x402 `exact` USDC payment (an EIP-3009 `transferWithAuthorization`
   authorization) for exactly the advertised amount.
4. `tools/call` again with the `PAYMENT-SIGNATURE` header — the server verifies
   and settles the payment through an x402 facilitator, runs the tool, and
   returns the result with a `PAYMENT-RESPONSE` settlement receipt.

## Run it

```bash
npm install

# Against the MCP tool server (x402-buyer-demo.js):
node x402-buyer-demo.js                               # see the price, no wallet
BUYER_PRIVATE_KEY=0x<key> node x402-buyer-demo.js     # full paid tool call

# Against the main runtime's /x402/commands/execute (x402-command-demo.js),
# when the runtime is in x402_facilitator mode:
node x402-command-demo.js                             # see the price, no wallet
BUYER_PRIVATE_KEY=0x<key> node x402-command-demo.js   # full paid command
```

```bash
# Self-serve credits: pay once and receive spendable runtime credits
# (x402-credits-topup-demo.js), when the runtime is in x402_facilitator mode:
node x402-credits-topup-demo.js                              # see price + credits, no wallet
BUYER_PRIVATE_KEY=0x<key> node x402-credits-topup-demo.js    # pay and receive credits
```

> ⚠️ **Real-money note.** The demo pays in whatever network the server advertises
> in its 402. **The live endpoint currently prices in real USDC on Base mainnet
> (~$0.01 per call)** — a funded paid run spends real money. The no-wallet run is
> always free. If the server advertises Base Sepolia instead, you pay test USDC;
> fund a throwaway wallet from the Circle faucet (<https://faucet.circle.com>).

No native gas token is needed. The payment is gasless for the buyer: you sign an
EIP-3009 authorization and the facilitator broadcasts the transfer and pays gas.

Then pass that wallet's private key as `BUYER_PRIVATE_KEY`.

> On PowerShell, set the key as its own statement, not inline:
> `$env:BUYER_PRIVATE_KEY = "0x<key>"; node x402-buyer-demo.js`

## Proven

This loop has been run against the live server end to end on **Base mainnet with
real USDC**: the signed payment verified at the facilitator, settled on-chain, the
tool executed, and the response carried a `PAYMENT-RESPONSE` receipt with the
settlement transaction hash. Run it yourself with a funded wallet to reproduce it.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_URL` | `https://xytara-mcp-executor.onrender.com/mcp` | the paid MCP endpoint |
| `BUYER_PRIVATE_KEY` | *(unset)* | 0x EVM key holding USDC on the advertised network (real USDC on Base mainnet today) |
| `TOOL` | `summarize` | any catalog tool (run `tools/list`), e.g. `summarize`, `x402.verify-receipt`, `eip712.hash` |
| `TEXT` | sample sentence | input text for `summarize` / `reply.draft` |

## How to read the outcome

- **No key**: stops after the 402 and prints exactly how to fund and retry.
- **Unfunded key**: reaches `payment_verification_failed` with an
  `insufficient_balance` detail. This is a feature: it proves the signed payment
  is well-formed and reached the facilitator; it just has nothing to settle.
- **Funded key**: prints the tool result and a settlement receipt with the
  transaction hash.

## Notes

- This example talks only to the public naxytra endpoints; it uses `viem` for
  EIP-712 signing and carries no server internals or credentials.
- The payment is gasless for the buyer: you sign an EIP-3009 authorization, and
  the facilitator broadcasts the USDC transfer. You never submit a transaction.
- The demo settles on whichever network the server advertises in its 402. The
  live endpoint currently advertises **Base mainnet (real USDC)**; a funded paid
  run spends real money. The no-wallet run is free.
