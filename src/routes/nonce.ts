import { Hono } from 'hono';
import { getNonceFromProvider } from '../services/provider';
import { getNonceFromAlchemy } from '../services/alchemy';
import { handleError } from '../utils/error-utils';
import { Secrets, Variables } from '../types';
export const registerNonceRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Route: Get Nonce
	app.post('/nonce', async (c) => {
		try {
			const { address } = await c.req.json();
			if (!address) {
				return c.json({ error: 'Missing required parameter: address' }, 400);
			}

			const nonce = await getNonceFromProvider(address);
			return c.json({ nonce });
		} catch (error) {
			const errorResponse = handleError(error, 'getNonce');
			return c.json(errorResponse);
		}
	});

	// Route: Get Nonce by Fetch from Alchemy
	app.post('/nonce-by-fetch', async (c) => {
		try {
			const { address } = await c.req.json();
			if (!address) {
				return c.json({ error: 'Missing required parameter: address' }, 400);
			}

			const nonce = await getNonceFromAlchemy(address, c.env.ALCHEMY_API_KEY);
			return c.json({ nonce });
		} catch (error) {
			const errorResponse = handleError(error, 'getNonceByFetch');
			return c.json(errorResponse);
		}
	});
};
