import { Provider, utils, types } from 'zksync-ethers';
import { ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS, ZKSYNC_SEPOLIA_CHAIN_ID } from '../utils/constants';

// Create provider
const provider = Provider.getDefaultProvider(types.Network.Sepolia);

// Get nonce using the provider
export const getNonceFromProvider = async (address: string) => {
	if (!address) {
		throw new Error('Missing address parameter');
	}

	console.log('getNonce. Address: ', address);
	const nonce = await provider.getTransactionCount(address, 'pending');
	console.log('getNonce. Latest Nonce, perhaps pending: ', nonce);

	return nonce.toString();
};

// Broadcast a signed transaction
export const broadcastTransaction = async (signedTransaction: string) => {
	return provider.sendRawTransactionWithDetailedOutput(signedTransaction);
};

// Prepare a transfer transaction
export const prepareTransferTransaction = async (from: string, to: string, amount: bigint, nonce: string) => {
	// Create transfer transaction
	const transferTx = await provider.getTransferTx({
		from,
		to,
		amount,
		token: ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS,
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
		chainId: ZKSYNC_SEPOLIA_CHAIN_ID,
		customData: {
			gasPerPubdata: fee.gasPerPubdataLimit,
			factoryDeps: [],
		},
	};

	return completeTransferTx;
};

// Check balance
export const checkUSDCBalance = async (address: string) => {
	return provider.getBalance(address, 'latest', ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS);
};

export { provider };
