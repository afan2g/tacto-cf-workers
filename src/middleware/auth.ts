import { Context, Next } from 'hono';
import { createSupabaseClient } from '../services/supabase';

export const authMiddleware = async (c: Context, next: Next) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) {
		console.log('Missing authorization header');
		return c.json({ error: 'Missing authorization header' }, 401);
	}

	const jwt = authHeader.replace('Bearer ', '');
	const supabase = createSupabaseClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);

	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser(jwt);

	if (authError || !user) {
		console.log('Authentication failed:', authError);
		return c.json({ error: 'Authentication failed' }, 401);
	}

	// Add user to context for route handlers
	c.set('user', user);

	await next();
};
