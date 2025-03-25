import axios from 'axios';
import { handleError } from '../utils/error-utils';
import * as crypto from 'crypto';
import { utils } from 'zksync-ethers';
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

export const isValidSignatureForStringBody = (body: string, signature: string, signingKey: string) => {
	try {
		const hmac = crypto.createHmac('sha256', signingKey);
		hmac.update(body, 'utf8');
		const digest = hmac.digest('hex');
		return signature === digest;
	} catch (error) {
		console.error('Error validating signature:', error);
		return false;
	}
};

export const parseAlchemyWebhookActivity = (activities: any[]) => {
	{
		if (!Array.isArray(activities) || activities.length === 0) {
			return { mainTransfer: null, totalFees: 0 };
		}

		// Find the main token transfer
		const mainTransfer = activities.find(
			(activity) =>
				activity.category !== 'external' &&
				activity.asset !== 'ETH' &&
				activity.fromAddress !== utils.BOOTLOADER_FORMAL_ADDRESS &&
				activity.toAddress !== utils.BOOTLOADER_FORMAL_ADDRESS
		);

		if (!mainTransfer) {
			return { mainTransfer: null, totalFees: 0 };
		}

		// Calculate net ETH fee (amount sent to system contract minus amount returned)
		const ethFees = activities.filter((activity) => activity.asset === 'ETH');
		let totalFees = 0;

		for (const activity of ethFees) {
			if (activity.toAddress === utils.BOOTLOADER_FORMAL_ADDRESS) {
				totalFees += activity.value; // Fee paid to system
			} else if (activity.fromAddress === utils.BOOTLOADER_FORMAL_ADDRESS) {
				totalFees -= activity.value; // Refund from system
			}
		}

		return {
			mainTransfer,
			totalFees,
		};
	}
};
