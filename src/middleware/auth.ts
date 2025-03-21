import { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';
export const authMiddleware = async (c: Context, next: Next) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) {
		console.log('Missing authorization header');
		return c.json({ error: 'Missing authorization header' }, 401);
	}

	const jwt = authHeader.replace('Bearer ', '');
	const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);

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
	c.set('supabase', supabase);
	await next();
};

// Profile middleware - loads the user's profile
export const profileMiddleware = async (c: Context, next: Next) => {
	const user = c.get('user');
	const supabase = c.get('supabase');

	// Get user profile
	const { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('id', user.id).single();

	if (profileError) {
		console.log('Error fetching user profile:', profileError);
		return c.json({ error: 'Failed to fetch user profile' }, 500);
	}

	c.set('profile', profile);
	await next();
};
