# alph-zap

Nostr x Alephium identity bridge. Every Nostr user already has an Alephium address — derived deterministically from their public key. Both protocols use secp256k1 with BIP-340 Schnorr signatures, so the same private key signs on both networks with the same algorithm.

## How It Works

A Nostr npub (32-byte x-only secp256k1 public key) is embedded in a Schnorr verification script:

```
AssetScript Schnorr(publicKey: ByteVec) {
  pub fn unlock() -> () {
    verifyBIP340Schnorr!(txId!(), publicKey, getSegregatedSignature!())
  }
}
```

The compiled script is hashed with Blake2b-256 to produce an Alephium P2SH address:

```
address = base58(0x02 || blake2b_256(script_bytecode))
```

This derivation is deterministic and public — anyone can compute anyone's Alephium address from their npub alone. No onboarding, no new keys, no wallet setup.

## Components

### Web Client (`web/index.html`)

A single-page Nostr client with ALPH Zap buttons. Connects to any Nostr relay, displays a feed of notes, and lets you send ALPH to any note author.

**Features:**
- Connects to Nostr relays via WebSocket
- Derives each author's Alephium address from their npub
- ALPH Zap panel with amount presets (1, 10, 100 ALPH) and custom input
- Identity banner showing your npub, ALPH address (linked to explorer), QR code, and balance
- Two signing methods:
  - **Extension signing**: Uses `window.nostr.signSchnorr()` (supported by [Alby](https://getalby.com))
  - **Local nsec signing**: Enter your nsec directly in the browser — key never leaves the page

**Run it:**

```bash
npm install
npm run serve
# Opens at http://localhost:3000
```

Or just open `web/index.html` directly — it uses ESM imports from CDN (no build step).

### CLI Wallet (`src/nostr-alph-wallet.js`)

A Node.js CLI wallet for sending and receiving ALPH using a Nostr nsec.

```bash
# Mainnet (default)
npm run wallet

# Testnet
node src/nostr-alph-wallet.js --testnet

# Custom node
node src/nostr-alph-wallet.js --node https://your-node:22973
```

**Flow:**
1. Enter nsec (bech32) or raw hex private key
2. Derives your Nostr npub + Alephium P2SH address
3. Queries balance from Alephium node
4. Enter destination (ALPH address or npub) and amount
5. Builds unsigned transaction via node API
6. Signs locally with BIP-340 Schnorr
7. Broadcasts signed transaction

The private key never leaves the client.

### Address Derivation Library (`src/npub-to-alephium.js`)

Standalone library for npub-to-address derivation with tests.

```bash
npm test
```

**Exports:**
- `npubToAlephiumAddress(npub)` — derive ALPH address from npub
- `pubkeyToAlephiumAddress(pubkeyHex)` — derive from raw pubkey hex
- `schnorrScriptToNpub(scriptHex)` — extract npub from on-chain unlock script
- `verifySchnorrPubkeyForAddress(pubkeyHex, address)` — verify a pubkey matches an address

## Extension Support

The web client supports two signing paths:

| Extension | Method | Status |
|-----------|--------|--------|
| [Alby](https://getalby.com) | `window.nostr.signSchnorr()` | Works |
| nos2x, nos2x-fox, Flamingo, Amber | — | No raw signing; use nsec fallback |

Standard NIP-07 only provides `signEvent()` which signs SHA-256 of event JSON — not usable for Alephium transactions (which need signing of a Blake2b-256 hash). The `signSchnorr(hash)` method is non-standard and currently only implemented by Alby.

When no compatible extension is detected, the web client shows an nsec input field for local signing. The nsec is used entirely in-browser via `@noble/curves` — it is never transmitted anywhere.

## Architecture

```
Nostr npub (32-byte x-only secp256k1 pubkey)
    |
    | embed in Schnorr P2SH script
    | blake2b_256 hash
    | base58 encode
    v
Alephium P2SH address
    |
    | query balance via public node API
    | build unsigned transaction
    | sign txId with BIP-340 Schnorr (same algo as Nostr)
    | broadcast signed transaction
    v
On-chain ALPH transfer
```

Both signing operations (Nostr events and Alephium transactions) use identical BIP-340 Schnorr with the same tagged hashes (`BIP0340/aux`, `BIP0340/nonce`, `BIP0340/challenge`). The only difference is the message hash function: Nostr uses SHA-256 of event JSON, Alephium uses Blake2b-256 of serialized unsigned transaction.

## Dependencies

**Node.js (CLI wallet + library):**
- `@alephium/web3` — Alephium SDK
- `@alephium/web3-wallet` — wallet utilities
- `nostr-tools` — npub/nsec encoding

**Web client (loaded from CDN, no build step):**
- `blakejs` — Blake2b hashing
- `qrcode` — QR code generation
- `@noble/curves` — BIP-340 Schnorr signing (nsec fallback)

## Technical Specification

See [alph-zap.md](alph-zap.md) for the full technical spec covering:
- Detailed address derivation algorithm
- Group (shard) assignment
- Transaction signing flow
- Reverse derivation from on-chain data
- ALPH Zap event format (draft NIP)
- End-to-end testnet proof of concept (3 confirmed transactions)

## Known Issues

`npm audit` reports 13 vulnerabilities — all are transitive dependencies inside `@alephium/web3` (protobufjs, elliptic, etc.). These packages are used internally by the Alephium SDK for node communication and do not affect this project's signing logic, which uses `@noble/curves` (browser) and the SDK's Schnorr wallet (CLI). The vulnerabilities have no exploitable path in this context. They will resolve when upstream publishes updated dependencies.

## License

MIT
