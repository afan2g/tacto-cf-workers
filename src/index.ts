import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { Provider, utils, types } from 'zksync-ethers';

// Constants
const ZKSYNC_USDC_CONTRACT_ADDRESS = '0xAe045DE5638162fa134807Cb558E15A3F5A7F853';
const ZKSYNC_CHAIN_ID = 300; // zkSync Sepolia testnet

// Create provider
const provider = Provider.getDefaultProvider(types.Network.Sepolia);

// Helper function for consistent JSON responses
const createJsonResponse = (data: any, status = 200) => {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
		},
	});
};

// Interface definitions
interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
}

interface TransactionInfo {
	toUserId: string;
	methodId: number;
	requestId?: string;
	memo?: string;
}

interface RequestBody {
	action: string;
	signedTransaction?: string;
	txRequest?: types.TransactionLike;
	txInfo?: TransactionInfo;
	address?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Handle preflight OPTIONS request
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		// Only accept POST requests for the API
		if (request.method !== 'POST') {
			return createJsonResponse({ error: 'Method not allowed' }, 405);
		}

		// Initialize Supabase client
		const supabaseUrl = env.SUPABASE_URL;
		const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

		if (!supabaseUrl || !supabaseServiceKey) {
			//console.log('Missing Supabase configuration');
			return createJsonResponse({ error: 'Server configuration error' }, 500);
		}

		const supabase = createClient(supabaseUrl, supabaseServiceKey);

		try {
			// Authenticate user
			const authHeader = request.headers.get('Authorization');
			if (!authHeader) {
				//console.log('Missing authorization header');
				return createJsonResponse({ error: 'Missing authorization header' }, 401);
			}

			const jwt = authHeader.replace('Bearer ', '');
			const {
				data: { user },
				error: authError,
			} = await supabase.auth.getUser(jwt);

			if (authError || !user) {
				return createJsonResponse({ error: 'Authentication failed' }, 401);
			}

			// Parse request body
			let requestBody: RequestBody;
			try {
				requestBody = (await request.json()) as RequestBody;
			} catch (e) {
				return createJsonResponse({ error: 'Invalid JSON in request body' }, 400);
			}

			const { action, ...params } = requestBody;

			if (!action) {
				return createJsonResponse({ error: 'Missing required parameter: action' }, 400);
			}

			//console.log('Received request:', action, params);
			// Handle different actions
			switch (action) {
				case 'broadcastTxUSDC': {
					// Validate required parameters
					const { signedTransaction, txRequest, txInfo } = params;

					//console.log('broadcastTxUSDC. SignedTransaction: ', signedTransaction);
					//console.log('broadcastTxUSDC. txRequest: ', txRequest);
					//console.log('broadcastTxUSDC. txInfo: ', txInfo);
					if (!signedTransaction || !txRequest || !txInfo) {
						//console.log('Missing required parameters for broadcastTxUSDC:', params);
						return createJsonResponse({ error: 'Missing required parameters for broadcastTxUSDC' }, 400);
					}

					// Validate txInfo fields
					if (!txInfo.toUserId || !txInfo.methodId) {
						//console.log('Missing required fields in txInfo:', txInfo);
						return createJsonResponse({ error: 'Missing required fields in txInfo' }, 400);
					}

					try {
						// Broadcast transaction
						const txResponseDetailedOutput = await provider.sendRawTransactionWithDetailedOutput(signedTransaction);

						// Format amount with error handling
						let formattedAmount = '0';
						try {
							formattedAmount = ethers.formatUnits(txRequest.value ?? 0, 6); // USDC has 6 decimals
						} catch (error) {
							//console.log('Error formatting amount:', error);
						}

						// Insert transaction record
						const { data: transactionRecord, error: txInsertError } = await supabase
							.from('transactions')
							.insert({
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
							})
							.select()
							.single();

						if (txInsertError) {
							//console.log('Failed to insert transaction record', txInsertError);
							return createJsonResponse(
								{
									error: 'Failed to insert transaction record',
									details: txInsertError.message,
								},
								500
							);
						}

						return createJsonResponse(
							utils.toJSON({
								...txResponseDetailedOutput,
								transaction_id: transactionRecord.id,
							})
						);
					} catch (error) {
						//console.log('Error broadcasting USDC transaction:', error);
						return createJsonResponse(
							{
								error: 'Failed to broadcast USDC transaction',
								details: error instanceof Error ? error.message : 'Unknown error',
							},
							500
						);
					}
				}

				case 'getCompleteTransferTx': {
					const { txRequest } = params;
					if (!txRequest || !txRequest.from || !txRequest.to || !txRequest.value) {
						return createJsonResponse(
							{
								error: 'Invalid transaction request. Required: from, to, value',
							},
							400
						);
					}

					try {
						// Get balances and nonce in parallel
						const [usdcBalance, ethBalance, nonce] = await Promise.all([
							provider.getBalance(txRequest.from, 'latest', ZKSYNC_USDC_CONTRACT_ADDRESS),
							provider.getBalance(txRequest.from, 'latest'),
							provider.getTransactionCount(txRequest.from),
						]);

						// Check USDC balance
						if (usdcBalance < BigInt(txRequest.value)) {
							return createJsonResponse(
								{
									error: 'Insufficient USDC balance',
									available: usdcBalance.toString(),
									required: txRequest.value.toString(),
								},
								400
							);
						}

						// Create transfer transaction
						const transferTx = await provider.getTransferTx({
							from: txRequest.from,
							to: txRequest.to,
							amount: txRequest.value,
							token: ZKSYNC_USDC_CONTRACT_ADDRESS,
						});

						// Estimate fee
						const fee = await provider.estimateFee(transferTx);

						// Create complete transaction
						const completeTransferTx = {
							...transferTx,
							...fee,
							nonce,
							value: 0,
							type: utils.EIP712_TX_TYPE,
							chainId: ZKSYNC_CHAIN_ID,
							customData: {
								gasPerPubdata: fee.gasPerPubdataLimit,
								factoryDeps: [],
							},
						};

						return createJsonResponse(utils.toJSON(completeTransferTx));
					} catch (error) {
						//console.log('Error preparing transaction:', error);
						return createJsonResponse(
							{
								error: 'Failed to prepare transaction',
								details: error instanceof Error ? error.message : 'Unknown error',
							},
							500
						);
					}
				}

				default: {
					return createJsonResponse({ error: `Unsupported action: ${action}` }, 400);
				}
			}
		} catch (error) {
			// console.log('Unexpected error:', error);
			ctx.waitUntil(
				// Log detailed error information (you might want to send this to a logging service)
				new Promise<void>((resolve) => {
					console.log({
						message: 'Worker execution failed',
						error:
							error instanceof Error
								? {
										name: error.name,
										message: error.message,
										stack: error.stack,
								  }
								: 'Unknown error',
					});
					resolve();
				})
			);

			return createJsonResponse(
				{
					error: 'Internal server error',
					message: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	},
} satisfies ExportedHandler<Env>;
