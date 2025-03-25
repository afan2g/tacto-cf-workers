import { Hono } from 'hono';
import { TransactionProcessor } from '../services/webhook-transaction-processor';
import { alchemyWebhookAuth } from '../middleware/webhook-auth';
import { Secrets, Variables } from '../types';

export const registerWebhookRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Alchemy transaction webhook
	app.post('/webhooks/alchemy-transaction', alchemyWebhookAuth, async (c) => {
		try {
			// Get the already parsed JSON body from middleware
			const payload = c.get('jsonBody');

			// Validate webhook data structure
			if (!payload.event?.activity || !Array.isArray(payload.event.activity)) {
				console.error('Invalid webhook payload structure');
				return c.json({ message: 'Webhook processed' });
			}

			const processor = new TransactionProcessor(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, c.env.EXPO_ACCESS_TOKEN);

			const transactionDetails = processor.parseTransactionDetails(payload.event.activity);
			const success = await processor.processTransaction(transactionDetails);

			console.log('Transaction processed successfully:', success);

			// Always return 200 for webhook, but include processing status
			return c.json({
				message: 'Webhook processed successfully',
				success,
			});
		} catch (error) {
			console.error('Error processing webhook:', error);
			// Return 200 to prevent webhook retries, but include error info in logs
			return c.json({
				message: 'Webhook processed',
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	});
};
