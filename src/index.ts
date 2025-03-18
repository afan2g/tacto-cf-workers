import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { Provider, utils, types } from 'zksync-ethers';
import axios from 'axios';

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
	ALCHEMY_API_KEY: string;
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

interface NonceResponse {
	data: {
		nonce?: string;
		error?: string;
		details?: string;
	};
	status: number;
}

// Standardized error handling
const handleError = (error: unknown, context: string): NonceResponse => {
	console.error(`Error in ${context}:`, error);

	if (axios.isAxiosError(error)) {
		if (error.response) {
			return {
				data: {
					error: `Failed in ${context}`,
					details: JSON.stringify(error.response.data),
				},
				status: error.response.status,
			};
		} else if (error.request) {
			return {
				data: {
					error: `Request failed in ${context}`,
					details: 'No response received',
				},
				status: 500,
			};
		}
	}

	return {
		data: {
			error: `Failed in ${context}`,
			details: error instanceof Error ? error.message : 'Unknown error',
		},
		status: 500,
	};
};

// Get nonce using the provider
const getNonce = async (address: string): Promise<NonceResponse> => {
	console.log('getNonce. Address: ', address);

	if (!address) {
		return { data: { error: 'Missing required parameter: address' }, status: 400 };
	}

	try {
		const nonce = await provider.getTransactionCount(address, 'pending');
		console.log('getNonce. Latest Nonce, perhaps pending: ', nonce);
		return { data: { nonce: nonce.toString() }, status: 200 };
	} catch (error) {
		return handleError(error, 'getNonce');
	}
};

// Get nonce using the Alchemy API
const getNonceByFetch = async (address: string, ALCHEMY_API_KEY: string): Promise<NonceResponse> => {
	console.log('getNonceByFetch. Address: ', address);

	if (!address) {
		return { data: { error: 'Missing required parameter: address' }, status: 400 };
	}

	const options = {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		data: JSON.stringify({
			id: 1,
			jsonrpc: '2.0',
			params: [address, 'latest'],
			method: 'eth_getTransactionCount',
		}),
	};

	try {
		const response = await axios.post(`https://zksync-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`, options.data, {
			headers: options.headers,
		});

		console.log('getNonceByFetch. Response: ', response.data);

		if (response.data.result) {
			const nonceValue = parseInt(response.data.result, 16).toString();
			return { data: { nonce: nonceValue }, status: 200 };
		} else {
			return {
				data: {
					error: 'Invalid response from Alchemy API',
					details: 'No result field in response',
				},
				status: 500,
			};
		}
	} catch (error) {
		return handleError(error, 'getNonceByFetch');
	}
};

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
			console.error('Missing Supabase configuration');
			return createJsonResponse({ error: 'Server configuration error' }, 500);
		}

		const supabase = createClient(supabaseUrl, supabaseServiceKey);

		try {
			// Authenticate user
			const authHeader = request.headers.get('Authorization');
			if (!authHeader) {
				console.log('Missing authorization header');
				return createJsonResponse({ error: 'Missing authorization header' }, 401);
			}

			const jwt = authHeader.replace('Bearer ', '');
			const {
				data: { user },
				error: authError,
			} = await supabase.auth.getUser(jwt);

			if (authError || !user) {
				console.log('Authentication failed:', authError);
				return createJsonResponse({ error: 'Authentication failed' }, 401);
			}

			// Parse request body
			let requestBody: RequestBody;
			try {
				requestBody = (await request.json()) as RequestBody;
				console.log('Request body:', requestBody);
			} catch (e) {
				console.log('Invalid JSON in request body:', e);
				return createJsonResponse({ error: 'Invalid JSON in request body' }, 400);
			}

			const { action, ...params } = requestBody;

			if (!action) {
				console.log('Missing required parameter: action');
				return createJsonResponse({ error: 'Missing required parameter: action' }, 400);
			}

			console.log('Received request:', action, params);

			// Handle different actions
			switch (action) {
				case 'getNonce': {
					const { address } = params;
					if (!address) {
						return createJsonResponse({ error: 'Missing required parameter: address' }, 400);
					}
					const nonceResponse = await getNonce(address);
					return createJsonResponse(nonceResponse.data, nonceResponse.status);
				}

				case 'getNonceByFetch': {
					const { address } = params;
					if (!address) {
						return createJsonResponse({ error: 'Missing required parameter: address' }, 400);
					}
					const nonceResponse = await getNonceByFetch(address, env.ALCHEMY_API_KEY);
					console.log('getNonceByFetch. Response: ', nonceResponse.data);
					return createJsonResponse(nonceResponse.data, nonceResponse.status);
				}

				case 'broadcastTxUSDC': {
					// Validate required parameters
					const { signedTransaction, txRequest, txInfo } = params;

					if (!signedTransaction || !txRequest || !txInfo) {
						console.log('Missing required parameters for broadcastTxUSDC:', params);
						return createJsonResponse({ error: 'Missing required parameters for broadcastTxUSDC' }, 400);
					}

					// Validate txInfo fields
					if (!txInfo.toUserId || txInfo.methodId === undefined) {
						console.log('Missing required fields in txInfo:', txInfo);
						return createJsonResponse({ error: 'Missing required fields in txInfo' }, 400);
					}

					try {
						// Broadcast transaction
						const txResponseDetailedOutput = await provider.sendRawTransactionWithDetailedOutput(signedTransaction);
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
							console.log('Failed to insert transaction record', txInsertError);
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
						console.log('Error broadcasting USDC transaction:', error);
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
						console.log('Invalid transaction request:', txRequest);
						return createJsonResponse(
							{
								error: 'Invalid transaction request. Required: from, to, value',
							},
							400
						);
					}

					try {
						// Get balances
						const [usdcBalance, nonceResponse] = await Promise.all([
							provider.getBalance(txRequest.from, 'latest', ZKSYNC_USDC_CONTRACT_ADDRESS),
							getNonceByFetch(txRequest.from, env.ALCHEMY_API_KEY),
						]);

						// Verify nonceResponse has a nonce
						if (!nonceResponse.data.nonce) {
							return createJsonResponse(
								{
									error: 'Failed to get nonce',
									details: nonceResponse.data.error || 'Unknown error',
								},
								nonceResponse.status
							);
						}

						// Extract nonce value
						const nonce = nonceResponse.data.nonce;

						// Check USDC balance
						const txValue = BigInt(txRequest.value.toString());
						if (usdcBalance < txValue) {
							return createJsonResponse(
								{
									error: 'Insufficient USDC balance',
									available: usdcBalance.toString(),
									required: txValue.toString(),
								},
								400
							);
						}

						// Create transfer transaction
						const transferTx = await provider.getTransferTx({
							from: txRequest.from,
							to: txRequest.to,
							amount: txValue,
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

						console.log('getCompleteTransferTx. Complete transfer transaction:', completeTransferTx);
						return createJsonResponse(utils.toJSON(completeTransferTx));
					} catch (error) {
						console.log('Error preparing transaction:', error);
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
			console.error('Unexpected error:', error);

			ctx.waitUntil(
				// Log detailed error information
				new Promise<void>((resolve) => {
					console.error({
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
