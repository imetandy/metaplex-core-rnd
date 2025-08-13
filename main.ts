import { 
  createCollection,
  mplCore,
  create,
  fetchCollection,
  burn as burnCore,
  fetchAsset,
  collectionAddress,
} from '@metaplex-foundation/mpl-core'
import {
  generateSigner,
  keypairIdentity,
  publicKey,
  some,
} from '@metaplex-foundation/umi'
import { mintV2, 
  createTreeV2, 
  fetchTreeConfigFromSeeds, 
  getAssetWithProof, 
  burnV2 
} from '@metaplex-foundation/mpl-bubblegum'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { Connection, 
  LAMPORTS_PER_SOL, 
  PublicKey,
  Keypair, 
  SystemProgram, 
  Transaction 
} from '@solana/web3.js'
import { 
  numberFormatter, 
  printSection, 
  sol, 
  solFromLamports, 
  getLamports as getLamportsHelper, 
  reportCost as reportCostHelper 
} from './helpers.ts'
import dotenv from 'dotenv'

dotenv.config()

const RPC = 'https://api.devnet.solana.com'

const umi = createUmi(RPC)
  .use(mplCore())
  .use(dasApi())
  .use(
    irysUploader({
      address: 'https://devnet.irys.xyz',
    })
  )
const connection = new Connection(RPC, 'confirmed')

// Scaling assumptions for projections
const MARKETS_PER_DAY = 24
const TRADES_PER_MARKET = 100

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

const depredictKeypair = umi.eddsa.createKeypairFromSecretKey(layer1Secret)
const marketKeypair = umi.eddsa.createKeypairFromSecretKey(marketSecret)
const userKeypair = umi.eddsa.createKeypairFromSecretKey(userSecret)
const userWeb3Keypair = Keypair.fromSecretKey(userSecret)

// Reusable helpers moved to helpers.ts
const reportCost = (prefix: string, sig: string) => reportCostHelper(connection, prefix, sig)
const getLamports = (address: string | PublicKey) => getLamportsHelper(connection, address)

// metadata helpers removed (handled separately)

async function simulateBurnFee(prefix: string) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: userWeb3Keypair.publicKey,
      toPubkey: userWeb3Keypair.publicKey,
      lamports: 0,
    })
  )
  const sig = await connection.sendTransaction(tx, [userWeb3Keypair])
  const cost = await reportCost(prefix, sig)
  return { sig, cost }
}

async function createCollectionFor(
  creator: 'depredict' | 'market', 
  name: string
): Promise<any> {
  
  const creatorKey = creator === 'depredict' ? depredictKeypair : marketKeypair
  umi.use(keypairIdentity(creatorKey))
  
  const colSigner = generateSigner(umi)

  const plugin: any = { type: 'BubblegumV2' };

  const tx = await createCollection(
    umi, 
    {
      collection: colSigner,
      name,
      uri: 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16',
      plugins: [plugin],
    }
  ).sendAndConfirm(umi)

  const sig = base58.deserialize(tx.signature)[0]
  console.log(`\nCollection Created (${creator}) -> ${colSigner.publicKey}`)
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`)
  const cost = await reportCost('Collection cost', sig)
  
  return { 
    collectionSigner: colSigner, 
    cost 
  }
}

async function ensureBubblegumTree(
  creator: 'depredict' | 'market', 
  opts?: { public?: boolean }
) 
  {
  
    const creatorKey = creator === 'depredict' ? depredictKeypair : marketKeypair
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

async function mintCoreToCollection(
  collectionAddress: string,
  details: { 
    marketId: string; 
    betType: 'yes' | 'no'; 
    amount: string 
  }
) {

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
  umi.use(keypairIdentity(depredictKeypair))
  const metadataUri = 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16'
  const tx = await create(umi, {
    asset: assetSigner,
    collection: getCollection,
    owner: userKeypair.publicKey,
    name: 'Position Core',
    uri: metadataUri,
    plugins: [
      {
        type: 'Attributes',
        attributeList: [
          { key: 'marketID', value: details.marketId },
          { key: 'BetType', value: details.betType },
          { key: 'amount', value: details.amount },
        ],
      },
    ],
  }).sendAndConfirm(umi)
  
  const sig = base58.deserialize(tx.signature)[0]
  const cost = await reportCost('Asset mint cost', sig)
  return { asset: assetSigner.publicKey, cost }

}

async function mintCompressedTo(
  collectionAddress: string | PublicKey,
  merkleTreeAddress: string | PublicKey,
  details: { marketId: string; betType: 'yes' | 'no'; amount: string }
) {
  umi.use(keypairIdentity(depredictKeypair))
  // ensure tree config present
  const merklePk = publicKey(merkleTreeAddress)
  const merklePkStr = merklePk.toString()
  const collectionPkStr = publicKey(collectionAddress).toString()
  for (let i = 0; i < 15; i++) {
    try {
      await fetchTreeConfigFromSeeds(umi, { merkleTree: merklePk })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const cnftUri = 'https://devnet.irys.xyz/metadata/QmZ4tDrQB1m8Vx97TQeHm22PpBHY3fjB3sFm7gSsVZj16'
  const { signature } = await mintV2(umi, {
    collectionAuthority: umi.identity,
    leafOwner: userKeypair.publicKey,
    merkleTree: merklePk,
    coreCollection: publicKey(collectionAddress),
    metadata: {
      name: 'Position (Compressed)',
      uri: cnftUri,
      sellerFeeBasisPoints: 0,
      collection: some(publicKey(collectionAddress)),
      creators: [],
      isMutable: false,
    },
  }).sendAndConfirm(umi)
  const sig = base58.deserialize(signature)[0]
  const cost = await reportCost('Compressed mint cost', sig)
  // After mint, fetch the newly minted cNFT assetId via DAS
  let assetId: string | undefined = undefined
  for (let i = 0; i < 20 && !assetId; i++) {
    try {
      const list: any = await (umi.rpc as any).getAssetsByOwner({ owner: userKeypair.publicKey })
      const items: any[] = list?.items || []
      const candidates = items.filter((it) => {
        const inTree = it?.compression?.tree === merklePkStr
        const inCollection = (it?.grouping || []).some((g: any) => g.group_key === 'collection' && g.group_value === collectionPkStr)
        const isCompressed = it?.compression?.compressed === true
        const nameMatches = it?.content?.metadata?.name === 'Position (Compressed)'
        return inTree && inCollection && isCompressed && nameMatches
      })
      if (candidates.length > 0) {
        candidates.sort((a, b) => (a?.compression?.seq || 0) - (b?.compression?.seq || 0))
        assetId = candidates[candidates.length - 1]?.id
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { cost, assetId }
}

async function burnCoreAssetAndMeasure(assetAddress: string) {
  // User must be the owner to authorize burn
  umi.use(keypairIdentity(userKeypair))
  const assetPk = publicKey(assetAddress)
  let asset: any
  for (let i = 0; i < 12; i++) {
    try {
      asset = await fetchAsset(umi, assetPk)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  if (!asset) throw new Error('Core asset not yet readable for burn')
  let collection: any = undefined
  try {
    const colAddr = collectionAddress(asset)
    if (colAddr) {
      collection = await fetchCollection(umi, colAddr)
    }
  } catch {}
  const preAssetLamports = await getLamports(assetPk)
  // Attribute logging removed (metadata handled separately)
  const tx = await burnCore(umi, {
    asset,
    collection,
  }).sendAndConfirm(umi)
  const sig = base58.deserialize(tx.signature)[0]
  console.log(`Core burn tx -> https://explorer.solana.com/tx/${sig}?cluster=devnet`)
  const cost = await reportCost('Core burn payer delta', sig)
  // Net received by payer (owner) is negative of payer delta if negative
  const reclaimNetLamports = Math.max(0, -cost.totalLamports)
  return { sig, cost, preAssetLamports, reclaimNetLamports }
}

async function burnCompressedAndMeasure(assetId: string, coreCollection?: string) {
  // User as leaf owner signs
  umi.use(keypairIdentity(userKeypair))
  let lastError: any = undefined
  for (let attempt = 0; attempt < 12; attempt++) {
    let assetWithProof: any
    // Refresh proof every attempt
    for (let i = 0; i < 12; i++) {
      try {
        assetWithProof = await (getAssetWithProof as any)(umi, publicKey(assetId), { truncateCanopy: true })
        // metadata logging removed
        break
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    if (!assetWithProof) {
      lastError = new Error('Could not fetch asset proof for cNFT burn')
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    try {
      const { signature } = await burnV2(umi, {
        ...assetWithProof,
        leafOwner: userKeypair.publicKey,
        coreCollection: coreCollection ? publicKey(coreCollection) : undefined,
      }).sendAndConfirm(umi)
      const sig = base58.deserialize(signature)[0]
      console.log(`Compressed burn tx -> https://explorer.solana.com/tx/${sig}?cluster=devnet`)
      const cost = await reportCost('Compressed burn payer delta', sig)
      return { sig, cost }
    } catch (e: any) {
      lastError = e
      const msg = String(e?.transactionMessage || e?.message || '')
      const logs = (e?.transactionLogs || []).join(' ')
      const proofMismatch = msg.includes("current leaf value does not match") || logs.includes("current leaf value does not match")
      // Backoff then retry with a fresh proof
      await new Promise((r) => setTimeout(r, proofMismatch ? 3000 : 1500))
    }
  }
  throw lastError
}

// Scenarios
async function runScenario1() {
  const { collectionSigner, cost: s1Collection } = await createCollectionFor('market', 'Market Collection S1')
  const { asset: s1CoreAsset, cost: s1CoreMint } = await mintCoreToCollection(collectionSigner.publicKey, {
    marketId: '100',
    betType: 'yes',
    amount: '1000',
  })
  const s1CoreAssetLamports = await getLamports(s1CoreAsset)
  let coreBurn: any = undefined
  try {
    coreBurn = await burnCoreAssetAndMeasure(s1CoreAsset)
  } catch (e) {
    console.warn('Core burn failed:', e)
  }
  return { scenario: 'Current setup', collection: s1Collection, tree: undefined, coreMint: s1CoreMint, coreAsset: s1CoreAsset, coreAssetLamports: s1CoreAssetLamports, coreBurn, compressedMint: undefined }
}

async function runScenario2() {
  const { collectionSigner, cost: s2Collection } = await createCollectionFor('depredict', 'Depredict Global S2')
  const { asset: s2CoreAsset, cost: s2CoreMint } = await mintCoreToCollection(collectionSigner.publicKey, {
    marketId: '100',
    betType: 'no',
    amount: '1000',
  })
  const s2CoreAssetLamports = await getLamports(s2CoreAsset)
  let coreBurn: any = undefined
  try {
    coreBurn = await burnCoreAssetAndMeasure(s2CoreAsset)
  } catch (e) {
    console.warn('Core burn failed:', e)
  }
  return { scenario: 'Scenario 2', collection: s2Collection, tree: undefined, coreMint: s2CoreMint, coreAsset: s2CoreAsset, coreAssetLamports: s2CoreAssetLamports, coreBurn, compressedMint: undefined }
}

async function runScenario3() {
  const { collectionSigner, cost: s3Collection } = await createCollectionFor('depredict', 'Depredict Global S3')
  const { merkleTree, cost: s3Tree } = await ensureBubblegumTree('market', { public: true })
  const { cost: s3Compressed, assetId: s3CnftAssetId } = await mintCompressedTo(collectionSigner.publicKey, merkleTree, {
    marketId: '100',
    betType: 'yes',
    amount: '1000',
  })
  let compressedBurn: any = undefined
  try {
    if (s3CnftAssetId) {
      compressedBurn = await burnCompressedAndMeasure(s3CnftAssetId, collectionSigner.publicKey)
    } else {
      console.warn('Could not resolve cNFT assetId after mint for Scenario 3')
    }
  } catch (e) {
    console.warn('cNFT burn failed:', e)
  }
  return { scenario: 'Scenario 3', collection: s3Collection, tree: s3Tree, coreMint: undefined, compressedMint: s3Compressed, compressedBurn }
}

async function runScenario4() {
  const { collectionSigner, cost: s4Collection } = await createCollectionFor('depredict', 'Depredict Global S4')
  const { merkleTree, cost: s4Tree } = await ensureBubblegumTree('depredict', { public: true })
  const { cost: s4Compressed, assetId: s4CnftAssetId } = await mintCompressedTo(collectionSigner.publicKey, merkleTree, {
    marketId: '100',
    betType: 'no',
    amount: '1000',
  })
  let compressedBurn: any = undefined
  try {
    if (s4CnftAssetId) {
      compressedBurn = await burnCompressedAndMeasure(s4CnftAssetId, collectionSigner.publicKey)
    } else {
      console.warn('Could not resolve cNFT assetId after mint for Scenario 4')
    }
  } catch (e) {
    console.warn('cNFT burn failed:', e)
  }
  return { scenario: 'Scenario 4', collection: s4Collection, tree: s4Tree, coreMint: undefined, compressedMint: s4Compressed, compressedBurn }
}

async function main() {
  const results = [] as any[]
  printSection('Current setup')
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
  const s1 = find('Current setup')
  const s2 = find('Scenario 2')
  const s3 = find('Scenario 3')
  const s4 = find('Scenario 4')
  const lamportsToSol = (x: number) => x / LAMPORTS_PER_SOL

  const projections = [
    {
      Scenario: 'Current setup',
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

  // Costs by Role (per-unit and daily)
  printSection('Costs by Role')
  const layerRows = [
    {
      Scenario: 'Scenario 1',
      'Depredict one-time (SOL)': numberFormatter.format(0),
      'Market owner per-market (SOL)': sol(s1.collection),
      'End user per-trade (SOL)': sol(s1.coreMint),
      'Market owner daily (SOL)': numberFormatter.format(
        lamportsToSol((s1.collection?.totalLamports || 0) * mpd)
      ),
      'End user daily (SOL)': numberFormatter.format(
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
      'Depredict one-time (SOL)': numberFormatter.format(
        lamportsToSol(s2.collection?.totalLamports || 0)
      ),
      'Market owner per-market (SOL)': numberFormatter.format(0),
      'End user per-trade (SOL)': sol(s2.coreMint),
      'Market owner daily (SOL)': numberFormatter.format(0),
      'End user daily (SOL)': numberFormatter.format(
        lamportsToSol((s2.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol((s2.coreMint?.totalLamports || 0) * tradesPerDay)
      ),
    },
    {
      Scenario: 'Scenario 3',
      'Depredict one-time (SOL)': numberFormatter.format(
        lamportsToSol(s3.collection?.totalLamports || 0)
      ),
      'Market owner per-market (SOL)': sol(s3.tree),
      'End user per-trade (SOL)': sol(s3.compressedMint),
      'Market owner daily (SOL)': numberFormatter.format(
        lamportsToSol((s3.tree?.totalLamports || 0) * mpd)
      ),
      'End user daily (SOL)': numberFormatter.format(
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
      'Depredict one-time (SOL)': numberFormatter.format(
        lamportsToSol(
          (s4.collection?.totalLamports || 0) + (s4.tree?.totalLamports || 0)
        )
      ),
      'Market owner per-market (SOL)': numberFormatter.format(0),
      'End user per-trade (SOL)': sol(s4.compressedMint),
      'Market owner daily (SOL)': numberFormatter.format(0),
      'End user daily (SOL)': numberFormatter.format(
        lamportsToSol((s4.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
      'Daily total (SOL)': numberFormatter.format(
        lamportsToSol((s4.compressedMint?.totalLamports || 0) * tradesPerDay)
      ),
    },
  ]
  console.table(layerRows)

  // Layer 3 user economics: mint spend vs burn reclaim vs delta
  printSection('Layer 3 user economics (per position, SOL)')
  const econRows = results.map((r) => {
    const mintLamports = (r.coreMint?.totalLamports || 0) + (r.compressedMint?.totalLamports || 0)
    const reclaimLamports = (r.coreBurn?.reclaimNetLamports || 0) // cNFTs: 0 by default
    const burnFeeLamports = (r.coreBurn?.cost?.feeLamports || r.coreBurn?.feeLamports || 0) + (r.compressedBurn?.cost?.feeLamports || r.compressedBurn?.feeLamports || 0)
    const deltaLamports = mintLamports + burnFeeLamports - reclaimLamports
    return {
      Scenario: r.scenario,
      'Mint spend': solFromLamports(mintLamports),
      'Burn fee': solFromLamports(burnFeeLamports),
      'Burn reclaim': solFromLamports(reclaimLamports),
      'Delta lost': solFromLamports(deltaLamports),
      Notes: r.coreAsset ? 'Core asset burn reclaims rent' : 'Compressed burn (no reclaim)'
    }
  })
  console.table(econRows)

  // Layer 3 operation costs (payer deltas and fees)
  printSection('Layer 3 operation costs (payer delta & tx fee, SOL)')
  const opRows = results.map((r) => {
    const mintCost = r.coreMint?.totalLamports || r.compressedMint?.totalLamports || 0
    const mintFee = r.coreMint?.feeLamports || r.compressedMint?.feeLamports || 0
    const burnCost = r.coreBurn?.cost?.totalLamports || r.compressedBurn?.cost?.totalLamports || 0
    const burnFee = r.coreBurn?.cost?.feeLamports || r.compressedBurn?.cost?.feeLamports || 0
    const metadataCost = 0
    const metadataEstimated = 0
    const arweaveEstSol = 0
    const totalBytes = 0
    return {
      Scenario: r.scenario,
      'Mint cost': solFromLamports(mintCost),
      'Mint tx fee': solFromLamports(mintFee),
      'Burn cost': solFromLamports(burnCost),
      'Burn tx fee': solFromLamports(burnFee),
      // Metadata costs removed; handled separately
    }
  })
  console.table(opRows)

  // Totals by Role per scenario (actual payer deltas summed)
  printSection('Totals by Role (per scenario, SOL)')
  const roleRows = results.map((r) => {
    const scenario = r.scenario as string
    // Depredict totals
    const depredictLamports =
      (scenario !== 'Current setup' ? (r.collection?.totalLamports || 0) : 0) +
      (scenario === 'Scenario 4' ? (r.tree?.totalLamports || 0) : 0)
    // Market owner totals
    const marketOwnerLamports =
      (scenario === 'Current setup' ? (r.collection?.totalLamports || 0) : 0) +
      (scenario === 'Scenario 3' ? (r.tree?.totalLamports || 0) : 0)
    // End user totals (mint + burn payer deltas)
    const endUserLamports =
      (r.coreMint?.totalLamports || 0) +
      (r.compressedMint?.totalLamports || 0) +
      (r.coreBurn?.cost?.totalLamports || 0) +
      (r.compressedBurn?.cost?.totalLamports || 0)
    const total = depredictLamports + marketOwnerLamports + endUserLamports
    return {
      Scenario: scenario,
      Depredict: solFromLamports(depredictLamports),
      'Market owner': solFromLamports(marketOwnerLamports),
      'End user': solFromLamports(endUserLamports),
      Total: numberFormatter.format(total / LAMPORTS_PER_SOL),
    }
  })
  console.table(roleRows)
}

main()

