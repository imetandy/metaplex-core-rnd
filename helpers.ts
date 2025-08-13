import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'

export const numberFormatter = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 6,
	maximumFractionDigits: 6,
})

export function printSection(title: string) {
	const line = '─'.repeat(title.length)
	console.log(`\n${title}\n${line}`)
}

export function sol(cost?: { totalLamports: number }) {
	return cost ? numberFormatter.format(cost.totalLamports / LAMPORTS_PER_SOL) : '-'
}

export function solFromLamports(lamports?: number) {
	return typeof lamports === 'number'
		? numberFormatter.format(lamports / LAMPORTS_PER_SOL)
		: '-'
}

export async function getLamports(connection: Connection, address: string | PublicKey): Promise<number> {
	const pk = typeof address === 'string' ? new PublicKey(address) : address
	return await connection.getBalance(pk, 'confirmed')
}

export async function reportCost(connection: Connection, prefix: string, sig: string) {
	const txInfo = await connection.getTransaction(sig, {
		maxSupportedTransactionVersion: 0,
		commitment: 'confirmed',
	})
	const feeLamports = txInfo?.meta?.fee ?? 0
	const payerCostLamports = (txInfo?.meta?.preBalances?.[0] ?? 0) - (txInfo?.meta?.postBalances?.[0] ?? 0)
	console.log(
		`${prefix}: ${(payerCostLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL (fee: ${(feeLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL)`
	)
	return { totalLamports: payerCostLamports, feeLamports }
}


