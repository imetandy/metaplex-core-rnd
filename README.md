# Prediction Markets NFT Architecture (Core vs Bubblegum v2)

Work in progress – numbers are current working assumptions from devnet runs and will vary with network conditions and code changes.

In depredict, we're using Core NFT to represent market positions, to allow them to be traded in secondary markets, and allow us to render them nice in wallets + on frontends. All markets spin up their own core collection, but we're finding te cost of this cannot scale effectively. 

## What we're comparing
- Core NFTs (MPL Core): standard account-backed assets. Burning returns most of the rent to the owner; a tiny lamport dust remains to prevent reopening. See Core burn: https://developers.metaplex.com/core/burn
- Compressed NFTs (Bubblegum v2): leaf entries in a Merkle tree (no rent-bearing account). Burning requires proof via DAS API and does not return rent. See Bubblegum burn: https://developers.metaplex.com/bubblegum-v2/burn-cnfts

## Scenarios
- Current setup: per-market Core collection; user mints Core NFT per position
- Scenario 2: global Core collection; user mints Core NFT per position
- Scenario 3: global Core collection; per-market Bubblegum tree; user mints cNFT per position
- Scenario 4: global Core collection; single global Bubblegum tree; user mints cNFT per position

## Projections with 24 markets/day and 100 trades/market (Daily SOL)
| Scenario        | One-time SOL | Daily SOL | Notes                                                   |
|-----------------|--------------|-----------|---------------------------------------------------------|
| Current setup   | 0.000000     | 10.061293 | No tree; collection per market; core mints per user     |
| Scenario 2      | 0.002342     | 9.988224  | Global collection; core mints per user                  |
| Scenario 3      | 0.002342     | 5.598910  | Global collection; tree per market; cNFTs per user      |
| Scenario 4      | 0.226130     | 0.228000  | Global collection; single global tree; cNFTs per user   |

## Costs by Role (per-unit and daily, SOL)
| Scenario     | Depredict one-time | Market owner per-market | End user per-trade | Market owner daily | End user daily | Daily total |
|--------------|--------------------|--------------------------|--------------------|--------------------|----------------|-------------|
| Scenario 1   | 0.000000           | 0.002349                 | 0.004169           | 0.056365           | 10.004928      | 10.061293   |
| Scenario 2   | 0.002342           | 0.000000                 | 0.004162           | 0.000000           | 9.988224       | 9.988224    |
| Scenario 3   | 0.002342           | 0.223788                 | 0.000095           | 5.370910           | 0.228000       | 5.598910    |
| Scenario 4   | 0.226130           | 0.000000                 | 0.000095           | 0.000000           | 0.228000       | 0.228000    |

## End-user per-position economics (SOL)
| Scenario        | Mint spend | Burn fee | Burn reclaim | Delta lost | Notes                          |
|-----------------|------------|----------|--------------|------------|--------------------------------|
| Current setup   | 0.004169   | 0.000005 | 0.001756     | 0.002418   | Core asset burn reclaims rent  |
| Scenario 2      | 0.004162   | 0.000005 | 0.001749     | 0.002418   | Core asset burn reclaims rent  |
| Scenario 3      | 0.000095   | 0.000005 | 0.000000     | 0.000100   | Compressed burn (no reclaim)   |
| Scenario 4      | 0.000095   | 0.000005 | 0.000000     | 0.000100   | Compressed burn (no reclaim)   |

## Totals by Role (per scenario, SOL)
| Scenario        | Depredict | Market owner | End user | Total    |
|-----------------|-----------|--------------|----------|----------|
| Current setup   | 0.000000  | 0.002349     | 0.002413 | 0.004761 |
| Scenario 2      | 0.002342  | 0.000000     | 0.002413 | 0.004754 |
| Scenario 3      | 0.002342  | 0.223788     | 0.000100 | 0.226230 |
| Scenario 4      | 0.226130  | 0.000000     | 0.000100 | 0.226230 |

## End-user operation costs (payer delta & tx fee, SOL)
| Scenario        | Mint cost | Mint tx fee | Burn cost  | Burn tx fee |
|-----------------|-----------|-------------|------------|-------------|
| Current setup   | 0.004169  | 0.000010    | -0.001756  | 0.000005    |
| Scenario 2      | 0.004162  | 0.000010    | -0.001749  | 0.000005    |
| Scenario 3      | 0.000095  | 0.000005    | 0.000005   | 0.000005    |
| Scenario 4      | 0.000095  | 0.000005    | 0.000005   | 0.000005    |


## Notes & assumptions
- Figures are devnet measurements; production mainnet costs and fees may differ.
- Additional data needs to be included for our markets. 
- We can store data on-chain for NFT Core assets for our program to read from, and assert against in order to allow for reclaimation of the users bet, but we cannot use this same flow for bubblegumNFTs. Would require us to store position with the cNFT assetID recorded. 
- Currently not handling metadata storage costs for bubblegum v2.  
- Core burn returns rent to the owner; a minimal dust remains. cNFTs have no rent to reclaim.

## References
- Core burn (rent reclaim semantics): https://developers.metaplex.com/core/burn
- Bubblegum v2 burn cNFTs (proof & burn flow): https://developers.metaplex.com/bubblegum-v2/burn-cnfts