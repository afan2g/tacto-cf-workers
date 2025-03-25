import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerNonceRoutes } from './routes/nonce';
import { registerTransactionRoutes } from './routes/transactions';
import { registerWebhookRoutes } from './routes/webhooks';
import { authMiddleware, profileMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { Secrets, Variables } from './types';
import { registerNotificationRoutes } from './routes';

// Initialize Hono app
const app = new Hono<{ Bindings: Secrets; Variables: Variables }>();

// Apply CORS middleware
app.use(
	'/*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'OPTIONS'],
		allowHeaders: ['authorization', 'x-client-info', 'apikey', 'content-type'],
		maxAge: 86400,
	})
);

registerWebhookRoutes(app);

// Apply auth to all routes except OPTIONS
app.use('/*', async (c, next) => {
	if (c.req.method === 'OPTIONS') {
		return next();
	}
	return authMiddleware(c, next);
});
app.use('/transactions/request/*', profileMiddleware);

// Register route handlers
registerNonceRoutes(app);
registerTransactionRoutes(app);
registerNotificationRoutes(app);

// Error handling
app.onError(errorHandler);

// Not found handler
app.notFound((c) => {
	return c.json({ error: 'Not found' }, 404);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
