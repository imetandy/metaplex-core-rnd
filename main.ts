import { 
  createCollection,
  mplCore,
  create,
  fetchCollection,
} from '@metaplex-foundation/mpl-core'
import {
  generateSigner,
  keypairIdentity,
  publicKey,
  some,
  signerIdentity,
} from '@metaplex-foundation/umi'
import { mintV2, createTreeV2, fetchTreeConfigFromSeeds } from '@metaplex-foundation/mpl-bubblegum'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import dotenv from 'dotenv'

dotenv.config()

const RPC = 'https://api.devnet.solana.com'
const umi = createUmi(RPC)
  .use(mplCore())
  .use(
    irysUploader({
      address: 'https://devnet.irys.xyz',
    })
  )
const connection = new Connection(RPC, 'confirmed')

// Scaling assumptions for projections
const MARKETS_PER_DAY = 24
const TRADES_PER_MARKET = 100

// Pretty-print helpers
const numberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
})
function printSection(title: string) {
  const line = '─'.repeat(title.length)
  console.log(`\n${title}\n${line}`)
}

// Identities
const layer1Secret = new Uint8Array(
  JSON.parse(process.env.DEPREDICT_PRIVATE_KEY || process.env.MARKET_PRIVATE_KEY || '[]')
)
const marketSecret = new Uint8Array(
  JSON.parse(process.env.MARKET_PRIVATE_KEY || '[]')
)
const userSecret = new Uint8Array(
  JSON.parse(process.env.POSITION_PRIVATE_KEY || process.env.USER_PRIVATE_KEY || '[]')
)
const layer1Keypair = umi.eddsa.createKeypairFromSecretKey(layer1Secret)
const marketKeypair = umi.eddsa.createKeypairFromSecretKey(marketSecret)
const userKeypair = umi.eddsa.createKeypairFromSecretKey(userSecret)

// Reusable helpers
async function reportCost(prefix: string, sig: string) {
  const txInfo = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  })
  const feeLamports = txInfo?.meta?.fee ?? 0
  const payerCostLamports = (txInfo?.meta?.preBalances?.[0] ?? 0) - (txInfo?.meta?.postBalances?.[0] ?? 0)
  console.log(`${prefix}: ${(payerCostLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL (fee: ${(feeLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL)`) 
  return { totalLamports: payerCostLamports, feeLamports }
}

function sol(cost?: { totalLamports: number }) {
  return cost ? numberFormatter.format(cost.totalLamports / LAMPORTS_PER_SOL) : '-'
}

async function createCollectionFor(creator: 'layer1' | 'market', name: string): Promise<any> {
  const creatorKey = creator === 'layer1' ? layer1Keypair : marketKeypair
  umi.use(keypairIdentity(creatorKey))
  const colSigner = generateSigner(umi)

  const plugin: any = { type: 'BubblegumV2' };

  const tx = await createCollection(umi, {
    collection: colSigner,
    name,
    uri: 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16',
    plugins: [plugin],
  }).sendAndConfirm(umi)
  const sig = base58.deserialize(tx.signature)[0]
  console.log(`\nCollection Created (${creator}) -> ${colSigner.publicKey}`)
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`)
  const cost = await reportCost('Collection cost', sig)
  return { collectionSigner: colSigner, cost }
}

async function ensureBubblegumTree(creator: 'layer1' | 'market', opts?: { public?: boolean }) {
  const creatorKey = creator === 'layer1' ? layer1Keypair : marketKeypair
  umi.use(keypairIdentity(creatorKey))
  const merkleTree = generateSigner(umi)
  const builder = await createTreeV2(umi, {
    merkleTree,
    maxBufferSize: 64,
    maxDepth: 14,
    public: opts?.public ?? true,
  })
  const { signature } = await builder.sendAndConfirm(umi)
  const sig = base58.deserialize(signature)[0]
  console.log('Bubblegum Tree Created')
  console.log(`Merkle Tree: ${merkleTree.publicKey}`)
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`)
  const cost = await reportCost('Tree creation cost', sig)
  // wait/poll tree config
  const merklePk = merkleTree.publicKey
  for (let i = 0; i < 15; i++) {
    try {
      await fetchTreeConfigFromSeeds(umi, { merkleTree: merklePk })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  return { merkleTree: merkleTree.publicKey, cost }
}

async function mintCoreToCollection(collectionAddress: string, owner: 'user') {
  // Retry until collection account is readable
  let getCollection: any
  for (let i = 0; i < 12; i++) {
    try {
      getCollection = await fetchCollection(umi, publicKey(collectionAddress))
      break
    } catch {
      await new Promise((r) => setTimeout(r, 2500))
    }
  }
  if (!getCollection) throw new Error('Collection not readable yet')

  umi.use(keypairIdentity(userKeypair))
  const assetSigner = generateSigner(umi)
  // collection authority must sign create into collection
  umi.use(keypairIdentity(layer1Keypair))
  const tx = await create(umi, {
    asset: assetSigner,
    collection: getCollection,
    owner: userKeypair.publicKey,
    name: 'Position Core',
    uri: 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16',
    plugins: [
      {
        type: 'Attributes',
        attributeList: [
          { key: 'marketID', value: '1' },
          { key: 'positionID', value: '1' },
          { key: 'orderType', value: 'market' },
          { key: 'orderStatus', value: 'open' },
          { key: 'orderPrice', value: '0' },
        ],
      },
    ],
  }).sendAndConfirm(umi)
  const sig = base58.deserialize(tx.signature)[0]
  const cost = await reportCost('Asset mint cost', sig)
  return { asset: assetSigner.publicKey, cost }
}

async function mintCompressedTo(collectionAddress: string, merkleTreeAddress: string) {
  umi.use(keypairIdentity(layer1Keypair))
  // ensure tree config present
  const merklePk = publicKey(merkleTreeAddress)
  for (let i = 0; i < 15; i++) {
    try {
      await fetchTreeConfigFromSeeds(umi, { merkleTree: merklePk })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const { signature } = await mintV2(umi, {
    collectionAuthority: umi.identity,
    leafOwner: userKeypair.publicKey,
    merkleTree: merklePk,
    coreCollection: publicKey(collectionAddress),
    metadata: {
      name: 'Position (Compressed)',
      uri: 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16',
      sellerFeeBasisPoints: 0,
      collection: some(publicKey(collectionAddress)),
      creators: [],
    },
  }).sendAndConfirm(umi)
  const sig = base58.deserialize(signature)[0]
  const cost = await reportCost('Compressed mint cost', sig)
  return { cost }
}

// Scenarios
async function runScenario1() {
  const { collectionSigner, cost: s1Collection } = await createCollectionFor('market', 'Market Collection S1')
  const { cost: s1CoreMint } = await mintCoreToCollection(collectionSigner.publicKey, 'user')
  return { scenario: 'Scenario 1', collection: s1Collection, tree: undefined, coreMint: s1CoreMint, compressedMint: undefined }
}

async function runScenario2() {
  const { collectionSigner, cost: s2Collection } = await createCollectionFor('layer1', 'Depredict Global S2')
  const { cost: s2CoreMint } = await mintCoreToCollection(collectionSigner.publicKey, 'user')
  return { scenario: 'Scenario 2', collection: s2Collection, tree: undefined, coreMint: s2CoreMint, compressedMint: undefined }
}

async function runScenario3() {
  const { collectionSigner, cost: s3Collection } = await createCollectionFor('layer1', 'Depredict Global S3')
  const { merkleTree, cost: s3Tree } = await ensureBubblegumTree('market', { public: true })
  const { cost: s3Compressed } = await mintCompressedTo(collectionSigner.publicKey, merkleTree)
  return { scenario: 'Scenario 3', collection: s3Collection, tree: s3Tree, coreMint: undefined, compressedMint: s3Compressed }
}

async function runScenario4() {
  const { collectionSigner, cost: s4Collection } = await createCollectionFor('layer1', 'Depredict Global S4')
  const { merkleTree, cost: s4Tree } = await ensureBubblegumTree('layer1', { public: true })
  const { cost: s4Compressed } = await mintCompressedTo(collectionSigner.publicKey, merkleTree)
  return { scenario: 'Scenario 4', collection: s4Collection, tree: s4Tree, coreMint: undefined, compressedMint: s4Compressed }
}

async function main() {
  const results = [] as any[]
  printSection('Scenario 1')
  results.push(await runScenario1())
  printSection('Scenario 2')
  results.push(await runScenario2())
  printSection('Scenario 3')
  results.push(await runScenario3())
  printSection('Scenario 4')
  results.push(await runScenario4())

  // Summary table (per-operation costs)
  printSection('Summary (per operation, SOL)')
  const summaryRows = results.map((r) => {
    const totalLamports =
      (r.collection?.totalLamports || 0) +
      (r.tree?.totalLamports || 0) +
      (r.coreMint?.totalLamports || 0) +
      (r.compressedMint?.totalLamports || 0)
    return {
      Scenario: r.scenario,
      Collection: sol(r.collection),
      Tree: sol(r.tree),
      'Core Mint': sol(r.coreMint),
      'Compressed Mint': sol(r.compressedMint),
      Total: numberFormatter.format(totalLamports / LAMPORTS_PER_SOL),
    }
  })
  console.table(summaryRows)

  // Projections (daily)
  const mpd = MARKETS_PER_DAY
  const tpm = TRADES_PER_MARKET
  const tradesPerDay = mpd * tpm
  const find = (name: string) => results.find((r) => r.scenario === name) || {}
  const s1 = find('Scenario 1')
  const s2 = find('Scenario 2')
  const s3 = find('Scenario 3')
  const s4 = find('Scenario 4')
  const lamportsToSol = (x: number) => x / LAMPORTS_PER_SOL

  const projections = [
    {
      Scenario: 'Scenario 1',
      'One-time SOL': numberFormatter.format(0),
      'Daily SOL': numberFormatter.format(
        lamportsToSol(
          (s1.collection?.totalLamports || 0) * mpd +
            (s1.coreMint?.totalLamports || 0) * tradesPerDay
        )
      ),
      Notes: 'No tree; collection per market; core mints per user',
    },
    {
      Scenario: 'Scenario 2',
      'One-time SOL': numberFormatter.format(
        lamportsToSol(s2.collection?.totalLamports || 0)
      ),
      'Daily SOL': numberFormatter.format(
        lamportsToSol((s2.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
      Notes: 'Global collection; core mints per user',
    },
    {
      Scenario: 'Scenario 3',
      'One-time SOL': numberFormatter.format(
        lamportsToSol(s3.collection?.totalLamports || 0)
      ),
      'Daily SOL': numberFormatter.format(
        lamportsToSol(
          (s3.tree?.totalLamports || 0) * mpd +
            (s3.compressedMint?.totalLamports || 0) * tradesPerDay
        )
      ),
      Notes: 'Global collection; tree per market; cNFTs per user',
    },
    {
      Scenario: 'Scenario 4',
      'One-time SOL': numberFormatter.format(
        lamportsToSol(
          (s4.collection?.totalLamports || 0) + (s4.tree?.totalLamports || 0)
        )
      ),
      'Daily SOL': numberFormatter.format(
        lamportsToSol((s4.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
      Notes: 'Global collection; single global tree; cNFTs per user',
    },
  ]
  printSection(
    `Projections with ${mpd} markets/day and ${tpm} trades/market (Daily SOL)`
  )
  console.table(projections)

  // Tree sizing guidance
  const yearlyLeaves = tradesPerDay * 365
  const depthFor = (need: number) => {
    const candidates = [14, 16, 18, 20, 24, 26, 30]
    for (const d of candidates) if (need <= Math.pow(2, d)) return d
    return 30
  }
  const globalDepth = depthFor(yearlyLeaves)
  printSection('Tree sizing guidance')
  const guidance = [
    {
      Case: 'Per-market tree',
      Recommendation: 'Depth 14 (16,384 leaves) typically sufficient',
      Rationale: `${tpm} trades/market/day; reset/rotate per market`,
    },
    {
      Case: 'Global tree',
      Recommendation: `Depth ${globalDepth} suggested`,
      Rationale: `${yearlyLeaves} leaves/year at current volume; consider 18–20 for headroom`,
    },
  ]
  console.table(guidance)

  // Costs by Layer (per-unit and daily)
  printSection('Costs by Layer')
  const layerRows = [
    {
      Scenario: 'Scenario 1',
      'Layer1 one-time (SOL)': numberFormatter.format(0),
      'Layer2 per-market (SOL)': sol(s1.collection),
      'Layer3 per-trade (SOL)': sol(s1.coreMint),
      'Layer2 daily (SOL)': numberFormatter.format(
        lamportsToSol((s1.collection?.totalLamports || 0) * mpd)
      ),
      'Layer3 daily (SOL)': numberFormatter.format(
        lamportsToSol((s1.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol(
          (s1.collection?.totalLamports || 0) * mpd +
            (s1.coreMint?.totalLamports || 0) * tradesPerDay
        )
      ),
    },
    {
      Scenario: 'Scenario 2',
      'Layer1 one-time (SOL)': numberFormatter.format(
        lamportsToSol(s2.collection?.totalLamports || 0)
      ),
      'Layer2 per-market (SOL)': numberFormatter.format(0),
      'Layer3 per-trade (SOL)': sol(s2.coreMint),
      'Layer2 daily (SOL)': numberFormatter.format(0),
      'Layer3 daily (SOL)': numberFormatter.format(
        lamportsToSol((s2.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol((s2.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
    },
    {
      Scenario: 'Scenario 3',
      'Layer1 one-time (SOL)': numberFormatter.format(
        lamportsToSol(s3.collection?.totalLamports || 0)
      ),
      'Layer2 per-market (SOL)': sol(s3.tree),
      'Layer3 per-trade (SOL)': sol(s3.compressedMint),
      'Layer2 daily (SOL)': numberFormatter.format(
        lamportsToSol((s3.tree?.totalLamports || 0) * mpd)
      ),
      'Layer3 daily (SOL)': numberFormatter.format(
        lamportsToSol((s3.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol(
          (s3.tree?.totalLamports || 0) * mpd +
            (s3.compressedMint?.totalLamports || 0) * tradesPerDay
        )
      ),
    },
    {
      Scenario: 'Scenario 4',
      'Layer1 one-time (SOL)': numberFormatter.format(
        lamportsToSol(
          (s4.collection?.totalLamports || 0) + (s4.tree?.totalLamports || 0)
        )
      ),
      'Layer2 per-market (SOL)': numberFormatter.format(0),
      'Layer3 per-trade (SOL)': sol(s4.compressedMint),
      'Layer2 daily (SOL)': numberFormatter.format(0),
      'Layer3 daily (SOL)': numberFormatter.format(
        lamportsToSol((s4.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol((s4.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
    },
  ]
  console.table(layerRows)
}

main()

