import { Context, Next } from 'hono';
import * as crypto from 'crypto';

/**
 * Validates the Alchemy webhook signature
 */
export function isValidSignatureForStringBody(body: string, signature: string, signingKey: string): boolean {
	try {
		const hmac = crypto.createHmac('sha256', signingKey);
		hmac.update(body, 'utf8');
		const digest = hmac.digest('hex');
		return signature === digest;
	} catch (error) {
		console.error('Error validating signature:', error);
		return false;
	}
}

/**
 * Middleware to verify Alchemy webhook signatures
 */
export const alchemyWebhookAuthMiddleware = async (c: Context, next: Next) => {
	// Store the raw body in the context for later use
	const rawBody = await c.req.text();
	c.set('rawBody', rawBody);

	try {
		// Basic validation of request body
		if (!rawBody) {
			return c.json({ error: 'Empty request body' }, 400);
		}

		// Try to parse JSON body
		try {
			const jsonBody = JSON.parse(rawBody);
			c.set('jsonBody', jsonBody);
		} catch (e) {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		// Get Alchemy signing key from environment
		const alchemySigningKey = c.env.ALCHEMY_ZKSYNC_SEPOLIA_WEBHOOK_SIGNING_KEY;

		// Verify signature
		const signature = c.req.header('X-Alchemy-Signature');

		if (!signature || !alchemySigningKey) {
			console.error('Missing signature or signing key');
			// Return 200 to avoid webhook retries, but log the error
			return c.json({ message: 'Webhook processed' });
		}

		if (!isValidSignatureForStringBody(rawBody, signature, alchemySigningKey)) {
			console.error('Invalid signature');
			// Return 200 to avoid webhook retries, but log the error
			return c.json({ message: 'Webhook processed' });
		}

		// Continue to the route handler if signature is valid
		await next();
	} catch (error) {
		console.error('Error in webhook auth middleware:', error);
		// Return 200 to prevent webhook retries, but include error info in logs
		return c.json({
			message: 'Webhook processed',
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
};

/**
 * Generic middleware factory for webhook authentication
 */
export const createWebhookAuthMiddleware = (
	headerName: string,
	signingKeyEnv: string,
	verifySignature: (body: string, signature: string, key: string) => boolean
) => {
	return async (c: Context, next: Next) => {
		// Store the raw body in the context for later use
		const rawBody = await c.req.text();
		c.set('rawBody', rawBody);

		try {
			// Basic validation of request body
			if (!rawBody) {
				return c.json({ error: 'Empty request body' }, 400);
			}

			// Try to parse JSON body
			try {
				const jsonBody = JSON.parse(rawBody);
				c.set('jsonBody', jsonBody);
			} catch (e) {
				return c.json({ error: 'Invalid JSON body' }, 400);
			}

			// Get signing key from environment
			const signingKey = c.env[signingKeyEnv];

			// Verify signature
			const signature = c.req.header(headerName);

			if (!signature || !signingKey) {
				console.error(`Missing signature (${headerName}) or signing key`);
				// Return 200 to avoid webhook retries, but log the error
				return c.json({ message: 'Webhook processed' });
			}

			if (!verifySignature(rawBody, signature, signingKey)) {
				console.error('Invalid signature');
				// Return 200 to avoid webhook retries, but log the error
				return c.json({ message: 'Webhook processed' });
			}

			// Continue to the route handler if signature is valid
			await next();
		} catch (error) {
			console.error('Error in webhook auth middleware:', error);
			// Return 200 to prevent webhook retries, but include error info in logs
			return c.json({
				message: 'Webhook processed',
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	};
};

// Create an Alchemy-specific middleware using the factory
export const alchemyWebhookAuth = createWebhookAuthMiddleware(
	'X-Alchemy-Signature',
	'ALCHEMY_ZKSYNC_SEPOLIA_WEBHOOK_SIGNING_KEY',
	isValidSignatureForStringBody
);
