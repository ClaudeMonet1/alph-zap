import { nip19 } from 'nostr-tools'
import { addressFromPublicKey, groupOfAddress } from '@alephium/web3'
import blakejs from 'blakejs'

// --- Constants ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// Compiled Ralph AssetScript:
//   AssetScript Schnorr(publicKey: ByteVec) {
//     pub fn unlock() -> () {
//       verifyBIP340Schnorr!(txId!(), publicKey, getSegregatedSignature!())
//     }
//   }
const SCHNORR_SCRIPT_PREFIX = '0101000000000458144020'
const SCHNORR_SCRIPT_SUFFIX = '8685'

// --- Internal helpers ---

function base58Encode(bytes) {
  let zeros = 0
  for (const b of bytes) {
    if (b === 0) zeros++
    else break
  }

  const digits = []
  for (const b of bytes) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  return '1'.repeat(zeros) + digits.reverse().map(d => BASE58_ALPHABET[d]).join('')
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function djb2(bytes) {
  let hash = 5381
  for (const b of bytes) {
    hash = ((hash << 5) + hash + (b & 0xff)) | 0
  }
  return hash
}

function xorByte(int32) {
  return ((int32 >>> 24) & 0xff) ^ ((int32 >>> 16) & 0xff) ^ ((int32 >>> 8) & 0xff) ^ (int32 & 0xff)
}

// --- Public API ---

/**
 * Compute the Alephium shard group (0-3) from a 32-byte address hash.
 * Algorithm: (xorByte(djb2(hash) | 1) & 0xFF) % 4
 */
function groupFromBytes(hashBytes) {
  const hint = djb2(hashBytes) | 1
  return (xorByte(hint) & 0xff) % 4
}

/**
 * Derive an Alephium P2SH (Schnorr) address from a Nostr npub.
 * @param {string} npub - bech32-encoded Nostr public key
 * @returns {{ address: string, pubkeyHex: string, group: number, scriptHex: string }}
 */
function npubToAlephiumAddress(npub) {
  const decoded = nip19.decode(npub)
  if (decoded.type !== 'npub') {
    throw new Error(`Expected npub, got ${decoded.type}`)
  }
  return pubkeyToAlephiumAddress(decoded.data)
}

/**
 * Derive an Alephium P2SH (Schnorr) address from a 32-byte x-only pubkey.
 * @param {string} pubkeyHex - 64-char hex string (32 bytes x-only secp256k1 pubkey)
 * @returns {{ address: string, pubkeyHex: string, group: number, scriptHex: string }}
 */
function pubkeyToAlephiumAddress(pubkeyHex) {
  if (pubkeyHex.length !== 64) {
    throw new Error(`Expected 32-byte pubkey (64 hex chars), got ${pubkeyHex.length}`)
  }

  const scriptHex = `${SCHNORR_SCRIPT_PREFIX}${pubkeyHex}${SCHNORR_SCRIPT_SUFFIX}`
  const scriptBytes = hexToBytes(scriptHex)
  const hash = blakejs.blake2b(scriptBytes, undefined, 32)

  const addressBytes = new Uint8Array(33)
  addressBytes[0] = 0x02 // P2SH
  addressBytes.set(hash, 1)

  return {
    address: base58Encode(addressBytes),
    pubkeyHex,
    group: groupFromBytes(hash),
    scriptHex
  }
}

/**
 * Extract the x-only pubkey from a Schnorr P2SH unlock script and convert to npub.
 * The pubkey sits at byte offset 11 (hex offset 22), length 32 bytes (64 hex chars).
 * @param {string} scriptHex - full script bytecode as hex
 * @returns {{ npub: string, pubkeyHex: string }}
 */
function schnorrScriptToNpub(scriptHex) {
  if (!scriptHex.startsWith(SCHNORR_SCRIPT_PREFIX) || !scriptHex.endsWith(SCHNORR_SCRIPT_SUFFIX)) {
    throw new Error('Not a Schnorr P2SH script')
  }
  const pubkeyHex = scriptHex.slice(SCHNORR_SCRIPT_PREFIX.length, -SCHNORR_SCRIPT_SUFFIX.length)
  if (pubkeyHex.length !== 64) {
    throw new Error(`Expected 32-byte pubkey (64 hex chars), got ${pubkeyHex.length}`)
  }
  return { npub: nip19.npubEncode(pubkeyHex), pubkeyHex }
}

/**
 * Verify that a Schnorr pubkey corresponds to a given Alephium address.
 * Recomputes the address from the pubkey and compares.
 * @param {string} pubkeyHex - 64-char hex x-only pubkey
 * @param {string} expectedAddress - Alephium base58 address to verify against
 * @returns {{ matches: boolean, derivedAddress: string, npub: string }}
 */
function verifySchnorrPubkeyForAddress(pubkeyHex, expectedAddress) {
  const derived = pubkeyToAlephiumAddress(pubkeyHex)
  return {
    matches: derived.address === expectedAddress,
    derivedAddress: derived.address,
    npub: nip19.npubEncode(pubkeyHex)
  }
}

export {
  npubToAlephiumAddress,
  pubkeyToAlephiumAddress,
  schnorrScriptToNpub,
  verifySchnorrPubkeyForAddress,
  groupFromBytes,
  SCHNORR_SCRIPT_PREFIX,
  SCHNORR_SCRIPT_SUFFIX
}

// --- Self-test when run directly ---

const isMain = process.argv[1]?.endsWith('npub-to-alephium.js')
if (isMain) {
  const TEST_PUBKEY = 'aecfc38a48f5fe7e050fca59de9f8d77fa7a7d9e63af608a95f8839de397f48a'
  const TEST_ADDRESS = 'qvegNNcKFBtkMcZTLj42pki2YDYTvHaGyBxBaWrPaHwj'

  let failures = 0
  function assert(label, condition) {
    const status = condition ? 'PASS' : 'FAIL'
    if (!condition) failures++
    console.log(`  ${status}  ${label}`)
  }

  console.log('=== npub <-> Alephium Address (P2SH/Schnorr) ===\n')

  // Test vector from alephium-web3 test suite
  console.log('Test vector:')
  const testNpub = nip19.npubEncode(TEST_PUBKEY)
  const testResult = npubToAlephiumAddress(testNpub)
  const testSdk = addressFromPublicKey(TEST_PUBKEY, 'bip340-schnorr')
  assert('address matches expected', testResult.address === TEST_ADDRESS)
  assert('address matches SDK', testResult.address === testSdk)
  assert('group matches SDK', testResult.group === groupOfAddress(testSdk))

  // Real npubs
  for (const [label, npub] of [
    ['jack', 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'],
    ['fiatjaf', 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6']
  ]) {
    console.log(`\n${label}:`)
    const result = npubToAlephiumAddress(npub)
    const sdk = addressFromPublicKey(result.pubkeyHex, 'bip340-schnorr')
    assert('address matches SDK', result.address === sdk)
    console.log(`  npub:    ${npub}`)
    console.log(`  address: ${result.address}`)
    console.log(`  group:   ${result.group}`)
  }

  // Round-trip tests
  console.log('\nRound-trip:')
  for (const [label, npub] of [
    ['test vector', testNpub],
    ['jack', 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'],
    ['fiatjaf', 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6']
  ]) {
    const forward = npubToAlephiumAddress(npub)
    const reverse = schnorrScriptToNpub(forward.scriptHex)
    const verified = verifySchnorrPubkeyForAddress(reverse.pubkeyHex, forward.address)
    assert(`${label}: npub -> address -> script -> npub`, reverse.npub === npub && verified.matches)
  }

  console.log(`\n${failures === 0 ? 'All tests passed.' : `${failures} test(s) failed.`}`)
  process.exit(failures === 0 ? 0 : 1)
}
