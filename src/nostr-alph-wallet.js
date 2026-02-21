#!/usr/bin/env node

/**
 * nostr-alph-wallet.js
 *
 * A minimal CLI wallet that lets a Nostr user interact with Alephium
 * using their nsec (Nostr private key) and BIP-340 Schnorr signatures.
 *
 * Usage:
 *   node src/nostr-alph-wallet.js [--node <url>] [--testnet]
 *
 * Flow:
 *   1. User provides nsec (bech32) or raw hex private key
 *   2. Script derives Alephium P2SH (Schnorr) address from the key
 *   3. Queries balance and UTXOs from the Alephium node
 *   4. User specifies destination (ALPH address or npub) and amount
 *   5. Builds unsigned transaction via node API
 *   6. Signs the txId locally with BIP-340 Schnorr (same algo as Nostr)
 *   7. Broadcasts the signed transaction via node API
 *
 * The private key never leaves the client.
 */

import { createInterface } from 'node:readline'
import { nip19 } from 'nostr-tools'
import { web3, DUST_AMOUNT, ONE_ALPH, addressFromPublicKey, groupOfAddress } from '@alephium/web3'
import { PrivateKeyWallet } from '@alephium/web3-wallet'

// --- Config ---

const MAINNET_NODE = 'https://node.mainnet.alephium.org'
const TESTNET_NODE = 'https://node.testnet.alephium.org'

const args = process.argv.slice(2)
const isTestnet = args.includes('--testnet')
const nodeIdx = args.indexOf('--node')
const nodeUrl = nodeIdx !== -1 ? args[nodeIdx + 1] : (isTestnet ? TESTNET_NODE : MAINNET_NODE)

// --- Helpers ---

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function formatAlph(attoAlph) {
  if (attoAlph === 0n) return '0 ALPH'
  const str = attoAlph.toString()
  if (str.length <= 18) {
    const frac = str.padStart(18, '0').replace(/0+$/, '')
    return `0.${frac} ALPH`
  }
  const whole = str.slice(0, str.length - 18)
  const frac = str.slice(str.length - 18).replace(/0+$/, '')
  return frac ? `${whole}.${frac} ALPH` : `${whole} ALPH`
}

function parseAlphToAtto(input) {
  input = input.trim().replace(/\s*ALPH$/i, '')
  const parts = input.split('.')
  if (parts.length === 1) {
    return BigInt(parts[0]) * ONE_ALPH
  }
  const whole = parts[0] || '0'
  const frac = parts[1].padEnd(18, '0').slice(0, 18)
  return BigInt(whole) * ONE_ALPH + BigInt(frac)
}

/**
 * Decode an nsec (bech32) or raw hex private key string into a hex private key.
 * @param {string} input - nsec bech32 string or 64-char hex string
 * @returns {string} 64-char hex private key
 */
function decodePrivateKey(input) {
  input = input.trim()
  if (input.startsWith('nsec1')) {
    const decoded = nip19.decode(input)
    if (decoded.type !== 'nsec') {
      throw new Error(`Expected nsec, got ${decoded.type}`)
    }
    // nip19.decode('nsec...') returns { type: 'nsec', data: Uint8Array }
    return bytesToHex(decoded.data)
  }
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return input
  }
  throw new Error('Invalid input. Provide an nsec (bech32) or 64-char hex private key.')
}

// --- Main ---

async function main() {
  console.log('=== Nostr-ALPH Wallet (BIP-340 Schnorr) ===\n')
  console.log(`Node:    ${nodeUrl}`)
  console.log(`Network: ${isTestnet ? 'testnet' : 'mainnet'}\n`)

  // Step 1: Get private key
  const nsecInput = await ask('Enter your nsec (or raw hex private key): ')
  const privateKeyHex = decodePrivateKey(nsecInput)

  // Step 2: Derive wallet
  web3.setCurrentNodeProvider(nodeUrl)

  const wallet = new PrivateKeyWallet({
    privateKey: privateKeyHex,
    keyType: 'bip340-schnorr'
  })

  const npub = nip19.npubEncode(wallet.publicKey)

  console.log(`\n--- Identity ---`)
  console.log(`Nostr npub:       ${npub}`)
  console.log(`Nostr pubkey:     ${wallet.publicKey}`)
  console.log(`ALPH address:     ${wallet.address}`)
  console.log(`ALPH group:       ${wallet.group}`)

  // Step 3: Query balance
  console.log(`\n--- Balance ---`)
  let balance
  try {
    balance = await web3.getCurrentNodeProvider().addresses.getAddressesAddressBalance(wallet.address)
  } catch (e) {
    if (e.message?.includes('not found') || e.status === 404) {
      console.log('Balance:          0 ALPH (address has never received funds)')
      console.log('\nSend ALPH to this address to get started.')
      console.log(`Address: ${wallet.address}`)
      rl.close()
      return
    }
    throw e
  }

  console.log(`Balance:          ${formatAlph(BigInt(balance.balance))}`)
  console.log(`Locked:           ${formatAlph(BigInt(balance.lockedBalance))}`)
  console.log(`UTXO count:       ${balance.utxoNum}`)

  if (balance.tokenBalances && balance.tokenBalances.length > 0) {
    console.log(`Tokens:`)
    for (const t of balance.tokenBalances) {
      console.log(`  ${t.id}: ${t.amount}`)
    }
  }

  const available = BigInt(balance.balance) - BigInt(balance.lockedBalance)
  if (available <= DUST_AMOUNT) {
    console.log('\nInsufficient balance for a transaction.')
    rl.close()
    return
  }

  // Step 4: Destination and amount
  console.log('\n--- Send ALPH ---')
  const destInput = await ask('Destination address (ALPH address or npub): ')

  let destAddress
  if (destInput.trim().startsWith('npub1')) {
    const decoded = nip19.decode(destInput.trim())
    if (decoded.type !== 'npub') {
      console.error('Invalid npub')
      process.exit(1)
    }
    destAddress = addressFromPublicKey(decoded.data, 'bip340-schnorr')
    console.log(`Derived ALPH address: ${destAddress} (group ${groupOfAddress(destAddress)})`)
  } else {
    destAddress = destInput.trim()
  }

  const amountInput = await ask(`Amount (e.g. 1.5 or 0.001, available: ${formatAlph(available)}): `)
  const attoAmount = parseAlphToAtto(amountInput)

  if (attoAmount < DUST_AMOUNT) {
    console.error(`Amount too small. Minimum is ${formatAlph(DUST_AMOUNT)}`)
    process.exit(1)
  }

  if (attoAmount > available) {
    console.error('Insufficient balance')
    process.exit(1)
  }

  // Step 5: Build transaction
  console.log('\n--- Transaction ---')
  console.log('Building transaction...')

  const buildResult = await wallet.buildTransferTx({
    signerAddress: wallet.address,
    signerKeyType: 'bip340-schnorr',
    destinations: [{
      address: destAddress,
      attoAlphAmount: attoAmount
    }]
  })

  console.log(`Transaction ID:   ${buildResult.txId}`)
  console.log(`From group:       ${buildResult.fromGroup}`)
  console.log(`To group:         ${buildResult.toGroup}`)
  console.log(`Gas:              ${buildResult.gasAmount} units`)
  console.log(`Gas price:        ${formatAlph(BigInt(buildResult.gasPrice))}`)

  // Step 6: Confirm
  const confirm = await ask('\nSign and broadcast? (y/n): ')
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled.')
    rl.close()
    return
  }

  // Step 7: Sign and broadcast
  console.log('\nSigning with BIP-340 Schnorr...')
  const signature = await wallet.signRaw(wallet.address, buildResult.txId)
  console.log(`Signature:        ${signature.slice(0, 32)}...${signature.slice(-8)}`)

  console.log('Broadcasting...')
  const submitResult = await web3.getCurrentNodeProvider().transactions.postTransactionsSubmit({
    unsignedTx: buildResult.unsignedTx,
    signature: signature
  })

  console.log(`\nTransaction broadcast!`)
  console.log(`TX ID:  ${submitResult.txId}`)
  console.log(`From:   group ${submitResult.fromGroup}`)
  console.log(`To:     group ${submitResult.toGroup}`)

  const explorerBase = isTestnet ? 'https://testnet.alephium.org' : 'https://explorer.alephium.org'
  console.log(`\nExplorer: ${explorerBase}/transactions/${submitResult.txId}`)

  rl.close()
}

main().catch((e) => {
  console.error('\nError:', e.message || e)
  if (e.body) console.error('Details:', JSON.stringify(e.body, null, 2))
  rl.close()
  process.exit(1)
})
