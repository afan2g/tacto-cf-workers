import { Hono } from 'hono';
import { ethers } from 'ethers';
import { utils } from 'zksync-ethers';
import { broadcastTransaction, prepareTransferTransaction, checkUSDCBalance } from '../services/provider';
import { getNonceFromAlchemy } from '../services/alchemy';
import { createSupabaseClient, insertTransaction } from '../services/supabase';
import { Secrets, Variables } from '../types';
export const registerTransactionRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Route: Broadcast USDC Transaction
	app.post('/transactions/usdc', async (c) => {
		try {
			const { signedTransaction, txRequest, txInfo } = await c.req.json();

			// Validate required parameters
			if (!signedTransaction || !txRequest || !txInfo) {
				return c.json({ error: 'Missing required parameters for broadcastTxUSDC' }, 400);
			}

			// Validate txInfo fields
			if (!txInfo.toUserId || txInfo.methodId === undefined) {
				return c.json({ error: 'Missing required fields in txInfo' }, 400);
			}

			// Broadcast transaction
			const txResponseDetailedOutput = await broadcastTransaction(signedTransaction);
			console.log('broadcastTxUSDC. Transaction response:', txResponseDetailedOutput);

			// Format amount with error handling
			let formattedAmount = '0';
			try {
				// Safely handle undefined value
				const value = txRequest.value !== undefined ? txRequest.value : 0;
				formattedAmount = ethers.formatUnits(value ?? 0, 6); // USDC has 6 decimals
			} catch (error) {
				console.log('Error formatting amount:', error);
			}

			// Insert transaction record
			const user = c.get('user');
			const supabase = createSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);

			const transactionData = {
				from_user_id: user.id,
				to_user_id: txInfo.toUserId,
				from_address: txRequest.from,
				to_address: txRequest.to,
				amount: formattedAmount,
				method_id: txInfo.methodId,
				request_id: txInfo.requestId,
				hash: txResponseDetailedOutput.transactionHash,
				status: 'pending',
				asset: 'USDC',
				fee: 0, // Will be updated later after confirmation
				created_at: new Date().toISOString(),
			};

			const transactionRecord = await insertTransaction(supabase, transactionData);

			return c.json(
				utils.toJSON({
					...txResponseDetailedOutput,
					transaction_id: transactionRecord.id,
				})
			);
		} catch (error) {
			console.log('Error broadcasting USDC transaction:', error);
			return c.json(
				{
					error: 'Failed to broadcast USDC transaction',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	// Route: Get Complete Transfer Transaction
	app.post('/transactions/prepare', async (c) => {
		try {
			const { txRequest } = await c.req.json();

			if (!txRequest || !txRequest.from || !txRequest.to || !txRequest.value) {
				return c.json(
					{
						error: 'Invalid transaction request. Required: from, to, value',
					},
					400
				);
			}

			// Get USDC balance
			const usdcBalance = await checkUSDCBalance(txRequest.from);

			// Get nonce
			const nonce = await getNonceFromAlchemy(txRequest.from, c.env.ALCHEMY_API_KEY);

			// Check USDC balance
			const txValue = BigInt(txRequest.value.toString());
			if (usdcBalance < txValue) {
				return c.json(
					{
						error: 'Insufficient USDC balance',
						available: usdcBalance.toString(),
						required: txValue.toString(),
					},
					400
				);
			}

			// Prepare transaction
			const completeTransferTx = await prepareTransferTransaction(txRequest.from, txRequest.to, txValue, nonce);

			console.log('getCompleteTransferTx. Complete transfer transaction:', completeTransferTx);
			return c.json(utils.toJSON(completeTransferTx));
		} catch (error) {
			console.log('Error preparing transaction:', error);
			return c.json(
				{
					error: 'Failed to prepare transaction',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});
};
