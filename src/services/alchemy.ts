import axios from 'axios';
import { handleError } from '../utils/error-utils';

// Get nonce using the Alchemy API
export const getNonceFromAlchemy = async (address: string, apiKey: string) => {
	console.log('getNonceByFetch. Address: ', address);

	if (!address) {
		throw new Error('Missing address parameter');
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
		const response = await axios.post(`https://zksync-sepolia.g.alchemy.com/v2/${apiKey}`, options.data, { headers: options.headers });

		console.log('getNonceByFetch. Response: ', response.data);

		if (response.data.result) {
			return parseInt(response.data.result, 16).toString();
		} else {
			throw new Error('Invalid response from Alchemy API: No result field in response');
		}
	} catch (error) {
		throw new Error(`Alchemy API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
};
