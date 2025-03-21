import { Hono } from 'hono';
import { NotificationService, NotificationMessage } from '../services/notification';
import { handleError } from '../utils/error-utils';
import { Secrets, Variables } from '../types';
export const registerNotificationRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Route: Register device token
	app.post('/notifications/register-token', async (c) => {
		try {
			const { pushToken } = await c.req.json();

			if (!pushToken) {
				return c.json({ error: 'Missing push token' }, 400);
			}

			const user = c.get('user');
			const supabase = c.get('supabase');

			// Check if token already exists for user
			const { data: existingToken, error: checkError } = await supabase
				.from('notification_tokens')
				.select('*')
				.eq('user_id', user.id)
				.eq('push_token', pushToken)
				.maybeSingle();

			if (checkError) {
				console.error('Error checking for existing token:', checkError);
				return c.json({ error: 'Failed to check for existing token' }, 500);
			}

			// Token already registered for this user
			if (existingToken) {
				return c.json({ message: 'Token already registered' });
			}

			// Insert new token
			const { error: insertError } = await supabase.from('notification_tokens').insert({
				user_id: user.id,
				push_token: pushToken,
				created_at: new Date().toISOString(),
			});

			if (insertError) {
				console.error('Error registering push token:', insertError);
				return c.json({ error: 'Failed to register push token' }, 500);
			}

			return c.json({ success: true, message: 'Token registered successfully' });
		} catch (error) {
			const errorResponse = handleError(error, 'registerPushToken');
			return c.json(errorResponse);
		}
	});

	// Route: Unregister device token
	app.post('/notifications/unregister-token', async (c) => {
		try {
			const { pushToken } = await c.req.json();

			if (!pushToken) {
				return c.json({ error: 'Missing push token' }, 400);
			}

			const user = c.get('user');
			const supabase = c.get('supabase');

			const { error } = await supabase.from('notification_tokens').delete().eq('user_id', user.id).eq('push_token', pushToken);

			if (error) {
				console.error('Error unregistering push token:', error);
				return c.json({ error: 'Failed to unregister push token' }, 500);
			}

			return c.json({ success: true, message: 'Token unregistered successfully' });
		} catch (error) {
			const errorResponse = handleError(error, 'unregisterPushToken');
			return c.json(errorResponse);
		}
	});

	// Admin route: Send notifications (requires admin permission check)
	app.post('/notifications/send', async (c) => {
		try {
			const { userIds, title, body, data } = await c.req.json();

			if (!userIds || !Array.isArray(userIds) || !title || !body) {
				return c.json(
					{
						error: 'Invalid request. Required: userIds (array), title, body',
					},
					400
				);
			}

			// Get the authenticated user
			const user = c.get('user');
			const supabase = c.get('supabase');
			// Check if user has admin permissions (implement according to your auth model)
			const { data: userData, error: userError } = await supabase.from('users').select('is_admin').eq('id', user.id).single();

			if (userError || !userData) {
				console.error('Error fetching user permissions:', userError);
				return c.json({ error: 'Failed to validate permissions' }, 500);
			}

			if (!userData.is_admin) {
				return c.json({ error: 'Unauthorized. Admin permissions required' }, 403);
			}

			// Create notification service
			const notificationService = new NotificationService(c.env.EXPO_ACCESS_TOKEN);

			// Send notifications
			const message: NotificationMessage = {
				title,
				body,
				data,
			};

			await notificationService.sendPushNotifications(userIds, message, supabase);

			return c.json({ success: true, message: 'Notifications sent successfully' });
		} catch (error) {
			const errorResponse = handleError(error, 'sendNotifications');
			return c.json(errorResponse);
		}
	});
};
