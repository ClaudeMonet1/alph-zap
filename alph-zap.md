# ALPH Zaps - Alephium Tipping on Nostr

## Core Insight

Nostr and Alephium both use **secp256k1** as their elliptic curve. A private key is a 256-bit scalar on that curve - it is not inherently bound to one protocol. This means every Nostr user already has a corresponding Alephium address, derived deterministically from their public key.

**Critical finding: Alephium natively supports BIP-340 Schnorr signatures** - the exact same algorithm Nostr uses for event signing. The `@alephium/web3` SDK has a built-in `'bip340-schnorr'` key type. This means a Nostr private key can sign Alephium transactions directly, with zero cryptographic adaptation.

---

## Address Derivation Approaches

Three possible ways to map a Nostr npub to an Alephium address were evaluated:

### Approach A: P2PKH via ECDSA (compressed pubkey)

```
npub (32-byte x-only) -> prepend 0x02 -> 33-byte compressed pubkey
  -> blake2b_256(compressed_pubkey) -> prepend 0x00 -> base58 encode
  = Alephium P2PKH address
```

- Standard P2PKH address, most compact transactions
- The same private key signs Nostr events (Schnorr) and Alephium transactions (ECDSA)
- Requires the signer to use a different algorithm (ECDSA) on the Alephium side

### Approach B: P2SH via BIP-340 Schnorr (x-only pubkey) [CHOSEN]

```
npub (32-byte x-only pubkey) -> embed in Schnorr unlock script bytecode:
  0101000000000458144020{32-byte-xonly-pubkey}8685
  -> blake2b_256(script_bytecode) -> prepend 0x02 -> base58 encode
  = Alephium P2SH address
```

- The same private key signs both Nostr events AND Alephium transactions using BIP-340 Schnorr
- Already supported by `@alephium/web3` SDK with `keyType: 'bip340-schnorr'`
- Slightly larger unlock scripts (script bytecode included in tx)
- **Same signing algorithm on both sides** - cleanest integration

### Approach C: Groupless P2PK via ECDSA (Danube hardfork)

```
npub (32-byte x-only) -> prepend 0x02 -> 33-byte compressed pubkey
  -> P2PK groupless address with SecP256K1 key type
  = Alephium groupless address (not bound to a specific shard)
```

- Groupless - not tied to any of Alephium's 4 shard groups
- However, BIP-340 Schnorr is NOT a variant in `PublicKeyLike` (only SecP256K1/ECDSA, SecP256R1, ED25519, WebAuthn)
- So this approach requires ECDSA signing, losing the Schnorr alignment with Nostr

**Decision: Approach B (Schnorr/P2SH)** because it uses the identical signing algorithm on both protocols. One key, one algorithm, two networks.

---

## Detailed Address Derivation (Verified from Alephium Source Code)

### Alephium Address Format

An Alephium address is: `base58(type_byte || body)`

| Type | Prefix Byte | Body |
|------|-------------|------|
| P2PKH | `0x00` | 32-byte Blake2b-256 hash of compressed public key |
| P2MPKH | `0x01` | compact-int encoded array of hashes + m value |
| P2SH | `0x02` | 32-byte Blake2b-256 hash of script bytecode |
| P2C | `0x03` | 32-byte contract ID |
| P2PK | `0x04` | encoded PublicKeyLike + checksum + group byte |
| P2HMPK | `0x05` | 32-byte hash + checksum + group byte |

Encoding is standard Base58 (NOT Base58Check - no checksum for P2PKH/P2SH/P2C).
Alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`

Sources:
- `alephium-web3/packages/web3/src/address/address.ts:252-268` (`addressFromPublicKey`)
- `alephium-web3/packages/web3/src/address/address.ts:39-46` (`AddressType` enum)
- `alephium/protocol/src/main/scala/org/alephium/protocol/vm/LockupScript.scala:44-73` (serde)
- `alephium/protocol/src/main/scala/org/alephium/protocol/vm/LockupScript.scala:119` (P2PKH: `Hash.hash(key.bytes)`)
- `alephium/crypto/src/main/scala/org/alephium/crypto/Blake2b.scala:31-35` (256-bit output)
- `alephium/util/src/main/scala/org/alephium/util/Base58.scala:24-90` (encoding, no checksum)

### Schnorr P2SH Script Bytecode

The Schnorr address uses a P2SH lockup script. The bytecode is the compiled form of:

```ralph
AssetScript Schnorr(publicKey: ByteVec) {
  pub fn unlock() -> () {
    verifyBIP340Schnorr!(txId!(), publicKey, getSegregatedSignature!())
  }
}
```

Compiled bytecode layout:

```
0101000000000458144020{32-byte-x-only-pubkey}8685
|                     |                      |
+-- script header     +-- pubkey embedded    +-- script footer
    (11 bytes)            at fixed offset        (2 bytes)
```

Total script size: 11 + 32 + 2 = 45 bytes.

The pubkey is at byte offset 11, length 32. This fixed layout enables extraction of the pubkey from on-chain data.

Source: `alephium/protocol/src/main/scala/org/alephium/protocol/model/Address.scala:73-99`

### npub to Alephium Address Algorithm

```
Input:  npub (bech32-encoded Nostr public key)
Output: Alephium P2SH address (base58-encoded)

1. Decode npub from bech32 -> 32-byte x-only secp256k1 public key (hex)
2. Construct script bytecode: "0101000000000458144020" + pubkeyHex + "8685"
3. Convert script hex to bytes
4. Hash: blake2b_256(script_bytes) -> 32-byte hash
5. Prepend type byte: [0x02] + hash -> 33 bytes
6. Encode: base58(33 bytes) -> Alephium address string
```

### Group Assignment (Sharding)

Alephium has 4 groups (shards). Every address belongs to a group, determining which shard processes its transactions.

```
group = (xorByte(djb2(blake2b_hash) | 1) & 0xFF) % 4
```

Step by step:
1. `blake2b_hash` = the 32-byte address body (the hash from step 4 above)
2. `djb2(bytes)` = DJB2 hash producing a 32-bit int: `hash = 5381; for each byte b: hash = ((hash << 5) + hash) + (b & 0xFF)`
3. `| 1` = set the least significant bit (ScriptHint convention)
4. `xorByte(int32)` = XOR fold 4 bytes into 1: `byte0 ^ byte1 ^ byte2 ^ byte3`
5. `& 0xFF` = treat as unsigned byte
6. `% 4` = modulo number of groups

Sources:
- `alephium-web3/packages/web3/src/address/address.ts:327-334` (`groupFromBytes`)
- `alephium-web3/packages/web3/src/utils/djb2.ts:19-25` (DJB2 hash)
- `alephium-web3/packages/web3/src/utils/utils.ts:159-164` (`xorByte`)
- `alephium-web3/packages/web3/src/constants.ts:19` (`TOTAL_NUMBER_OF_GROUPS = 4`)
- `alephium/util/src/main/scala/org/alephium/util/DjbHash.scala:23-27`
- `alephium/protocol/src/main/scala/org/alephium/protocol/model/ScriptHint.scala:25-36`
- `alephium/util/src/main/scala/org/alephium/util/Bytes.scala:24,62-68`

---

## Reverse Derivation: Alephium Address to npub

### From Address Alone: NOT POSSIBLE

The Alephium P2SH address is a blake2b-256 hash of the script bytecode. Blake2b is a one-way function - the pubkey cannot be recovered from the hash.

```
address = base58(0x02 || blake2b_256(script_with_embedded_pubkey))
                         ^^^^^^^^^^^
                         one-way, irreversible
```

### From On-Chain Unlock Script: POSSIBLE

When the address owner spends funds, the P2SH unlock script reveals the full script bytecode on-chain. The 32-byte x-only pubkey sits at a fixed offset (bytes 11-42) in the script.

```
Script hex:  0101000000000458144020{pubkey_here}8685
Offset:      0         11         11+32    43  45
```

Extraction steps:
1. Get the unlock script bytecode from a spending transaction
2. Verify it matches the Schnorr script format (prefix and suffix)
3. Extract bytes 11-42 (32 bytes) as the x-only public key
4. Encode as npub: `nip19.npubEncode(pubkeyHex)`
5. Optionally verify by recomputing the address from the extracted pubkey and comparing

### Verification of Extracted Pubkey

After extracting a pubkey from an on-chain unlock script, verify it actually corresponds to the address:

```
1. Take extracted pubkey (32 bytes x-only)
2. Reconstruct script: "0101000000000458144020" + pubkeyHex + "8685"
3. Hash: blake2b_256(script_bytes)
4. Build address: base58(0x02 || hash)
5. Compare with the spending address
6. If match: the extracted pubkey is confirmed, convert to npub
```

### Directionality Summary

| Direction | Possible? | Condition |
|-----------|-----------|-----------|
| npub -> ALPH address | Always | Deterministic, public computation |
| ALPH address -> npub | Never | One-way hash, no reverse |
| On-chain unlock script -> npub | After first spend | Pubkey revealed in P2SH unlock |
| npub -> ALPH address -> script -> npub | Always (round-trip) | The script is derived, not on-chain |

### Privacy Implication

Before a Nostr user's first Alephium spend, their address is opaque - only identifiable as a Schnorr P2SH by someone who computes the mapping themselves. After the first spend, the pubkey is public on-chain, and anyone can convert it to an npub, linking the Nostr identity to on-chain activity.

---

## Transaction Signing (Verified from Source)

### What Gets Signed

1. The `UnsignedTransaction` is serialized to bytes (Alephium binary serde format)
2. The serialized bytes are hashed with **Blake2b-256** to produce a 32-byte `TransactionId`
3. The `TransactionId` is the message that gets signed (it IS the hash - no double hashing)

Sources:
- `alephium/protocol/src/main/scala/org/alephium/protocol/model/UnsignedTransaction.scala:55`
- `alephium/protocol/src/main/scala/org/alephium/protocol/model/TransactionId.scala:45-47`
- `alephium/protocol/src/main/scala/org/alephium/protocol/model/Transaction.scala:226-229`
- `alephium-web3/packages/web3/src/transaction/sign-verify.ts:22-24`

### Signature Schemes Supported by Alephium

| Scheme | Key Size | Sig Size | Address Type | Used For |
|--------|----------|----------|--------------|----------|
| ECDSA secp256k1 | 33 bytes (compressed) | 64 bytes (r‖s, low-S) | P2PKH (0x00) | Default, protocol-level |
| BIP-340 Schnorr secp256k1 | 32 bytes (x-only) | 64 bytes (R_x‖s) | P2SH (0x02) | Leman hardfork, **same as Nostr** |
| ECDSA secp256r1 | 33 bytes | 64 bytes | P2PK (0x04) | Danube hardfork, WebAuthn |
| ED25519 | 32 bytes | 64 bytes | P2PK (0x04) | Danube hardfork |

**BIP-340 Schnorr in Alephium uses identical tagged hashes to Nostr:**
`BIP0340/aux`, `BIP0340/nonce`, `BIP0340/challenge`

Sources:
- `alephium/crypto/src/main/scala/org/alephium/crypto/SecP256K1.scala:142-190` (ECDSA)
- `alephium/crypto/src/main/scala/org/alephium/crypto/BIP340Schnorr.scala:83-217` (Schnorr)
- `alephium/protocol/src/main/scala/org/alephium/protocol/package.scala:28-37` (default types)
- `alephium/protocol/src/main/scala/org/alephium/protocol/vm/PublicKeyLike.scala:65-68` (P2PK key types)

### Schnorr P2SH Unlock Flow

1. The spending transaction provides the full script bytecode in `UnlockScript.P2SH`
2. The Alephium VM executes the script:
   - `txId!()` returns the 32-byte transaction ID
   - The embedded Schnorr public key (32 bytes, x-only) is loaded
   - `getSegregatedSignature!()` pops a 64-byte signature from `scriptSignatures`
   - `verifyBIP340Schnorr!(txId, pubkey, signature)` verifies the BIP-340 signature
3. Signatures are stored as `Byte64` in the `scriptSignatures` array (not `inputSignatures`)

Sources:
- `alephium/protocol/src/main/scala/org/alephium/protocol/vm/Instr.scala:1712-1734` (`VerifyBIP340Schnorr`)
- `alephium/protocol/src/main/scala/org/alephium/protocol/model/Transaction.scala:67-74` (tx structure)
- `alephium/flow/src/main/scala/org/alephium/flow/validation/TxValidation.scala:891-927` (P2PK verification)

### Nostr vs Alephium Signing Comparison

| | Nostr | Alephium (Schnorr) |
|---|---|---|
| Curve | secp256k1 | secp256k1 |
| Algorithm | BIP-340 Schnorr | BIP-340 Schnorr |
| Message hashed | SHA-256 of event JSON | Blake2b-256 of unsigned tx bytes |
| Message size | 32 bytes | 32 bytes |
| Signature size | 64 bytes | 64 bytes |
| Public key format | 32-byte x-only | 32-byte x-only |

The only difference is the hash function used to produce the 32-byte message (SHA-256 vs Blake2b-256). The signing algorithm itself is identical. The same private key produces valid signatures on both protocols.

---

## Prototype Implementation

### Setup

```bash
# Dependencies
npm install @alephium/web3 nostr-tools
```

### `src/npub-to-alephium.js`

The prototype implements four functions:

#### `npubToAlephiumAddress(npub)`

Derives an Alephium P2SH (Schnorr) address from a Nostr npub.

```javascript
npubToAlephiumAddress('npub14m8u8zjg7hl8upg0efvaa8udwla85lv7vwhkpz54lzpemcuh7j9qvla32m')
// {
//   address: 'qvegNNcKFBtkMcZTLj42pki2YDYTvHaGyBxBaWrPaHwj',
//   pubkeyHex: 'aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a',
//   group: 0,
//   scriptHex: '0101000000000458144020aecfc38a...8685'
// }
```

#### `pubkeyToAlephiumAddress(pubkeyHex)`

Derives an Alephium address from a raw 32-byte x-only pubkey hex string. Same as above but skips the npub decode step.

#### `schnorrScriptToNpub(scriptHex)`

Extracts the x-only pubkey from a Schnorr P2SH unlock script bytecode and converts to npub. This is the reverse operation, possible when the script is revealed on-chain.

```javascript
schnorrScriptToNpub('0101000000000458144020aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a8685')
// {
//   npub: 'npub14m8u8zjg7hl8upg0efvaa8udwla85lv7vwhkpz54lzpemcuh7j9qvla32m',
//   pubkeyHex: 'aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a'
// }
```

#### `verifySchnorrPubkeyForAddress(pubkeyHex, expectedAddress)`

Verifies that a Schnorr pubkey (extracted from an on-chain unlock script) actually corresponds to a given Alephium address. Recomputes the address from the pubkey and compares.

```javascript
verifySchnorrPubkeyForAddress(
  'aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a',
  'qvegNNcKFBtkMcZTLj42pki2YDYTvHaGyBxBaWrPaHwj'
)
// { matches: true, derivedAddress: 'qvegNNcKFBtkMcZTLj42pki2YDYTvHaGyBxBaWrPaHwj', npub: 'npub14m8u...' }
```

### Test Results

All derivations verified against both the Alephium SDK (`addressFromPublicKey` with `'bip340-schnorr'`) and known test vectors from the Alephium test suite.

```
=== Test vector (from alephium-web3 test suite) ===
pubkey:  aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a
address: qvegNNcKFBtkMcZTLj42pki2YDYTvHaGyBxBaWrPaHwj
group:   0
manual vs SDK:  PASS
manual vs expected: PASS

=== Jack Dorsey (npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m) ===
pubkey:  82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2
address: d2WwXZS7GuzPiNRn964r6QAFZQLgiq2W7Jx6ZeYtFRAa
group:   1
manual vs SDK: PASS

=== fiatjaf (npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6) ===
pubkey:  3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d
address: gFXgj25Lz7VKu4PtLbuMiGWMmYY5z2HoFHVcaeGemaeA
group:   2
manual vs SDK: PASS

=== Round-trip tests (npub -> address -> script -> npub) ===
test vector: PASS
jack:        PASS
fiatjaf:     PASS
```

---

## SDK Usage (TypeScript)

### Deriving Any Nostr User's Alephium Address

```typescript
import { addressFromPublicKey } from '@alephium/web3'
import { nip19 } from 'nostr-tools'

const npub = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'

// Decode npub to get 32-byte x-only pubkey
const { data: pubkeyHex } = nip19.decode(npub)

// Derive their Alephium address (Schnorr/P2SH)
const alphAddress = addressFromPublicKey(pubkeyHex, 'bip340-schnorr')
```

This is deterministic and public. Anyone can compute anyone's Alephium address from their npub alone.

### Creating a Wallet from a Nostr Private Key

```typescript
import { PrivateKeyWallet } from '@alephium/web3-wallet'
import { web3, ONE_ALPH } from '@alephium/web3'

web3.setCurrentNodeProvider('https://node.mainnet.alephium.org')

// A Nostr nsec IS a valid Alephium private key (both are 32-byte secp256k1 scalars)
const nostrPrivateKeyHex = '...' // nsec decoded to hex

const wallet = new PrivateKeyWallet({
  privateKey: nostrPrivateKeyHex,
  keyType: 'bip340-schnorr'  // Use Schnorr signing (same as Nostr)
})

// wallet.address   -> Alephium P2SH address
// wallet.publicKey -> 32-byte x-only pubkey (same as npub decoded)
// wallet.group     -> shard group (0-3)
```

Source: `alephium-web3/packages/web3-wallet/src/privatekey-wallet.ts:60-79`

### Sending ALPH

```typescript
const result = await wallet.signAndSubmitTransferTx({
  signerAddress: wallet.address,
  signerKeyType: 'bip340-schnorr',  // required for Schnorr P2SH addresses
  destinations: [{
    address: recipientAlephiumAddress,
    attoAlphAmount: ONE_ALPH  // 1 ALPH = 10^18 attoALPH
  }]
})
// result.txId      -> transaction ID
// result.signature -> BIP-340 Schnorr signature
```

---

## ALPH Zap Flow

### Sending a Zap

1. User A sees a Nostr post by User B
2. Client derives User B's Alephium address from their npub (no interaction needed)
3. User A signs an Alephium transaction sending ALPH to User B's derived address
4. Client publishes a Nostr event (new kind) containing the Alephium transaction ID
5. Relays propagate the zap event

### Receiving / Claiming a Zap

1. User B's client shows incoming ALPH zaps by querying zap events
2. User B's ALPH balance is visible at their derived address (on-chain, public)
3. To spend, User B signs an Alephium transaction using their nsec (BIP-340 Schnorr)
4. No new key management, no new seed phrase, no wallet setup

### Verification

Any client or relay can verify an ALPH zap:
1. Derive the recipient's Alephium address from their npub
2. Query the Alephium blockchain for the referenced transaction ID
3. Confirm the transaction sends to the derived address with the claimed amount

---

## Nostr Event Spec (Draft)

A new event kind for ALPH zaps (analogous to NIP-57 for Lightning):

```json
{
  "kind": "<TBD>",
  "content": "",
  "tags": [
    ["p", "<recipient pubkey hex>"],
    ["e", "<zapped event id>"],
    ["amount", "<amount in attoALPH>"],
    ["tx", "<alephium transaction id>"],
    ["network", "alephium-mainnet"],
    ["token", "ALPH"]
  ]
}
```

The `token` tag enables future support for zapping with any Alephium token, not just ALPH.

---

## Key Advantages Over Lightning Zaps

- **No invoice required**: Recipient doesn't need to be online or run infrastructure
- **No onboarding**: Every npub already has an Alephium address
- **On-chain verifiable**: Zaps are settled on-chain, independently verifiable by anyone
- **Token support**: Can zap any Alephium token, not just ALPH
- **Smart contract extensibility**: Conditional zaps, splits, streaming, escrow via Ralph contracts
- **Sharded throughput**: Alephium's 4-group sharding handles high zap volume
- **Same signing algorithm**: BIP-340 Schnorr on both sides, no crypto bridging needed

---

## Constants

```
1 ALPH            = 10^18 attoALPH
DUST_AMOUNT       = 10^15 attoALPH  (0.001 ALPH, minimum output)
DEFAULT_GAS       = 20,000 gas units
DEFAULT_GAS_PRICE = 10^11 attoALPH  (0.0000001 ALPH)
GROUPS            = 4
```

Source: `alephium-web3/packages/web3/src/constants.ts`

---

## CLI Wallet Prototype

### `src/nostr-alph-wallet.js`

A minimal CLI wallet that lets a Nostr user send and receive ALPH using their nsec.

#### Usage

```bash
# Mainnet (default)
node src/nostr-alph-wallet.js

# Testnet
node src/nostr-alph-wallet.js --testnet

# Custom node
node src/nostr-alph-wallet.js --node https://your-node:22973
```

#### Flow

```
1. User enters nsec (bech32) or raw hex private key
   |
2. Script derives:
   - Nostr npub and pubkey
   - Alephium P2SH (Schnorr) address and group
   |
3. Queries Alephium node for balance and UTXOs
   |
4. User enters destination (ALPH address or npub) and amount
   - If destination is an npub, auto-derives their ALPH address
   |
5. Builds unsigned transaction via node API
   - POST /transactions/build
   - Returns: unsignedTx, txId, gas info
   |
6. Signs txId locally with BIP-340 Schnorr
   - Same algorithm as Nostr event signing
   - Private key never leaves the client
   |
7. Broadcasts signed transaction via node API
   - POST /transactions/submit
   - Payload: { unsignedTx, signature }
```

#### Architecture

```
+------------------+       +-------------------+
|  User's nsec     |       |  Alephium Node    |
|  (BIP-340 key)   |       |  (backend)        |
+--------+---------+       +--------+----------+
         |                          |
         | derive                   |
         v                          |
+------------------+                |
|  ALPH P2SH addr  |  balance query |
|  (Schnorr)       +--------------->
|                  <----------------+
|                  |                |
|  build tx req    +--------------->  POST /transactions/build
|                  <----------------+  { unsignedTx, txId }
|                  |                |
|  sign(txId,nsec) |                |
|  BIP-340 Schnorr |                |
|                  |                |
|  submit signed   +--------------->  POST /transactions/submit
|                  <----------------+  { txId, fromGroup, toGroup }
+------------------+                |
                                    |
 Private key stays local.           |
 Node never sees the nsec.          |
+-----------------------------------+
```

#### Key Properties

- **nsec never leaves the client** - the node only receives the public key (for building) and the signature (for submission)
- **Destination can be an npub** - the script auto-derives the recipient's Alephium address
- **Uses `PrivateKeyWallet`** from `@alephium/web3-wallet` with `keyType: 'bip340-schnorr'`
- **Node API handles P2SH complexity** - the SDK manages unlock script construction, gas estimation, UTXO selection

#### Tested Output

```
=== Nostr-ALPH Wallet (BIP-340 Schnorr) ===

Node:    https://node.mainnet.alephium.org
Network: mainnet

Enter your nsec (or raw hex private key): 8fc5f0d1...

--- Identity ---
Nostr npub:       npub1n40nf5ktfx3hmvntru2k3t63esxhn727zszhwccc0na7tpuza2ussrfx8c
Nostr pubkey:     9d5f34d2cb49a37db26b1f1568af51cc0d79f95e14057763187cfbe58782eab9
ALPH address:     rLdArztzUFP8qDyMnmcDJ2NH9vd1Kk63DvbGk4M31H5M
ALPH group:       0

--- Balance ---
Balance:          0 ALPH
Locked:           0 ALPH
UTXO count:       0
```

---

## Testnet Proof of Concept - Live Test Results

The full ALPH Zaps flow was tested end-to-end on Alephium testnet, proving that a Nostr identity can receive and spend ALPH using only its nsec and BIP-340 Schnorr signatures.

### Test Setup

- **Network**: Alephium testnet
- **Node**: `https://node.testnet.alephium.org` (v4.3.1)
- **Explorer**: `https://backend.testnet.alephium.org`

A fresh Nostr keypair was generated for the test:

```
nsec: [redacted]
npub: npub1uycssj4dze4lg6pfcyrvlx07279dvw0paq0chvdmj87zphcnjqqqr5pl29
```

The Alephium P2SH (Schnorr) address was derived from this npub:

```
address: nwBNgLbEFL7gyLPCSu6ygLWC6MxvgrnNP3NnjKd2HZKY
group:   0
```

### Test 1: Receive ALPH at a Nostr-Derived Address

An external user (`npub17zjm30svf9gcfv6q7392up3jdq7ehkxtuly09rpzun0rmk3t3v3q355pu6`, address `bjkV1aBpmPTu7aXnEmj47FHyxo444iCNAbcKET4jz7P3`) sent 1 ALPH to the Nostr-derived address.

```
Direction:  external user -> Nostr-derived address
TX ID:      fc135e270ee7a869d4cc455bb6cf0cbe77f5202278d3910479fe3c3bd1205117
Amount:     1 ALPH
To address: nwBNgLbEFL7gyLPCSu6ygLWC6MxvgrnNP3NnjKd2HZKY
```

**Result**: The ALPH appeared at the derived address. The balance was queryable via the node API. No special setup was required on the recipient side - the address existed implicitly from the moment the npub was created.

### Test 2: Spend ALPH Using nsec (BIP-340 Schnorr Signing)

The test wallet spent ALPH back to the sender using the nsec as the signing key.

```
Direction:  Nostr-derived address -> external user
TX ID:      2b5cdf5dce14bfd5a117fbc66d8daa48ff7743d2c22155510561b0749995d0ab
Amount:     0.997 ALPH
From:       nwBNgLbEFL7gyLPCSu6ygLWC6MxvgrnNP3NnjKd2HZKY
To:         bjkV1aBpmPTu7aXnEmj47FHyxo444iCNAbcKET4jz7P3
Gas:        20,000 units (0.002 ALPH)
Signature:  d246fde134c180a6c5cb575b38d08abc4ace4e76da0b3181ac4b85c55f0afbd8
            0b20c76321f8b06f8211dd7d5c28205497b082b4e5e7dccd4aa9b0278ed5f201
```

Explorer: https://testnet.alephium.org/transactions/2b5cdf5dce14bfd5a117fbc66d8daa48ff7743d2c22155510561b0749995d0ab

**Result**: Transaction was built via the node API, signed locally with BIP-340 Schnorr (the same algorithm used for Nostr event signing), broadcast, and confirmed on-chain. The nsec never left the client.

### Test 3: npub-to-Address Derivation and Cross-Send

After receiving more ALPH, the test wallet derived the destination address directly from a recipient's npub and sent funds.

```
Direction:  Nostr-derived address -> npub-derived address
TX ID:      8f116f472969e8c90ace84561ed8ff50d89815d5c36b40129f268d3c137aecae
Amount:     0.998 ALPH
From:       nwBNgLbEFL7gyLPCSu6ygLWC6MxvgrnNP3NnjKd2HZKY (npub1uycss...r5pl29)
To:         bjkV1aBpmPTu7aXnEmj47FHyxo444iCNAbcKET4jz7P3 (npub17zjm3...55pu6)
```

Explorer: https://testnet.alephium.org/transactions/8f116f472969e8c90ace84561ed8ff50d89815d5c36b40129f268d3c137aecae

**Result**: The destination was specified only as an npub. The script derived the Alephium address deterministically and sent ALPH to it. This proves the full "zap by npub" flow: no need to know or share Alephium addresses - just the Nostr identity.

### Test Observations

1. **`signerKeyType` is required**: The SDK's `TransactionBuilder.validatePublicKey` checks that the pubkey matches the signer address. For Schnorr P2SH addresses, `signerKeyType: 'bip340-schnorr'` must be passed in the transaction params, otherwise the validation fails with "Unmatched public key".

2. **P2SH Schnorr unlock scripts are revealed on-chain**: After test 2, the unlock script bytecode (`0101000000000458144020{pubkey}8685`) appeared in the transaction, making the x-only public key (and therefore the npub) publicly extractable from the chain.

3. **The sender's address matched the npub derivation**: The external user's address `bjkV1aBpmPTu7aXnEmj47FHyxo444iCNAbcKET4jz7P3` was independently confirmed to be the P2SH Schnorr derivation of `npub17zjm30svf9gcfv6q7392up3jdq7ehkxtuly09rpzun0rmk3t3v3q355pu6`, proving the derivation is consistent across implementations.

4. **Gas cost**: A simple transfer costs 20,000 gas units at the default price of 10^11 attoALPH, totaling 0.002 ALPH per transaction.

5. **Dust minimum**: The minimum output is 0.001 ALPH (DUST_AMOUNT = 10^15 attoALPH). Sending "all" requires reserving at least gas + dust.

### What Was Proven

| Claim | Status | Evidence |
|-------|--------|----------|
| Every npub has a deterministic ALPH address | Confirmed | Derivation matches SDK, consistent across sender and receiver |
| A Nostr nsec can sign Alephium transactions | Confirmed | TX `2b5cdf5d...` signed with BIP-340 Schnorr and accepted on-chain |
| ALPH can be sent to an npub without recipient setup | Confirmed | TX `fc135e27...` received at address derived from npub alone |
| ALPH can be sent to a destination specified only by npub | Confirmed | TX `8f116f47...` sent to npub-derived address |
| The signing algorithm is identical to Nostr | Confirmed | BIP-340 Schnorr with same tagged hashes, verified by Alephium VM |
| The nsec stays local (never sent to node) | Confirmed | Only the public key and signature are transmitted |

---

## Resolved Technical Questions

- [x] **Address derivation**: `base58(0x02 || blake2b_256(schnorr_script_bytecode))` for Schnorr/P2SH
- [x] **Signing scheme**: BIP-340 Schnorr is natively supported, same algorithm as Nostr
- [x] **What gets signed**: 32-byte Blake2b-256 hash of serialized unsigned transaction (the txId)
- [x] **Minimum amounts**: DUST_AMOUNT = 0.001 ALPH minimum per output
- [x] **Group assignment**: Deterministic from address hash via DJB2 + xorByte, mod 4
- [x] **Reverse derivation**: Possible from on-chain unlock script (pubkey at bytes 11-42), not from address alone
- [x] **Round-trip**: npub -> address -> script -> npub verified correct for all test cases
- [x] **SDK compatibility**: Manual implementation matches `addressFromPublicKey(pubkey, 'bip340-schnorr')` exactly
- [x] **Groupless option**: P2PK groupless addresses exist but don't support Schnorr (ECDSA only via PublicKeyLike)
- [x] **End-to-end testnet**: Receive, sign (BIP-340 Schnorr), and send ALPH using only a Nostr nsec - 3 transactions confirmed
- [x] **npub as destination**: Can send ALPH to a recipient specified only by their npub
- [x] **Gas costs**: 20,000 gas units = 0.002 ALPH per simple transfer at default gas price

## Remaining Open Questions

- [ ] NIP number assignment and Nostr community review process
- [ ] Client UX for first-time Alephium interaction (balance display, fee estimation)
- [ ] Token zap flow (non-ALPH tokens on Alephium)
- [ ] Relay-side validation of ALPH zap events (query Alephium node?)
- [ ] Mobile wallet integration (NIP-07 equivalent for Alephium signing)
- [ ] Privacy considerations (address reuse, on-chain linkability to Nostr identity)
- [ ] HD derivation path alignment (Nostr: `m/44'/1237'/*`, Alephium Schnorr: `m/44'/1234'/1'/0/*`)

---

## File Index

| File | Description |
|------|-------------|
| `README.md` | Project overview, setup, and usage instructions |
| `alph-zap.md` | This document - ALPH Zaps technical spec and prototype docs |
| `web/index.html` | Single-page Nostr client with ALPH Zap buttons (extension + nsec signing) |
| `src/npub-to-alephium.js` | Library: npub to Alephium address derivation + reverse + round-trip |
| `src/nostr-alph-wallet.js` | CLI wallet: nsec input, balance query, build/sign/broadcast transactions |
