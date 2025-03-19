import { Context } from 'hono';

export const errorHandler = (err: Error, c: Context) => {
	console.error('Unexpected error:', err);

	return c.json(
		{
			error: 'Internal server error',
			message: err instanceof Error ? err.message : 'Unknown error',
		},
		500
	);
};
