import { Expo, ExpoPushMessage } from 'expo-server-sdk';

export interface NotificationMessage {
	title: string;
	body: string;
	data?: Record<string, any>;
}

export class NotificationService {
	private expo: Expo;

	constructor(accessToken: string) {
		this.expo = new Expo({ accessToken });
	}

	/**
	 * Sends push notifications to multiple users
	 * @param userIds Array of user IDs to send notifications to
	 * @param message Notification message details
	 * @param supabase Supabase client instance
	 */
	async sendPushNotifications(userIds: string[], message: NotificationMessage, supabase: any): Promise<void> {
		if (!userIds.length) {
			console.log('No user IDs provided for notifications');
			return;
		}

		try {
			const { data: tokens, error } = await supabase.from('notification_tokens').select('push_token').in('user_id', userIds);

			if (error) {
				console.error('Error fetching notification tokens:', error);
				return;
			}

			if (!tokens?.length) {
				console.log('No tokens found for the specified users');
				return;
			}

			console.log('Sending push notifications to:', tokens);

			const messages: ExpoPushMessage[] = tokens.map(({ push_token }: { push_token: string }) => ({
				to: push_token,
				sound: 'default',
				title: message.title,
				body: message.body,
				data: message.data,
			}));

			// Filter out any invalid tokens
			const validMessages = messages.filter((message) => Expo.isExpoPushToken(message.to as string));

			if (validMessages.length === 0) {
				console.log('No valid Expo push tokens found');
				return;
			}

			const chunks = this.expo.chunkPushNotifications(validMessages);

			for (const chunk of chunks) {
				try {
					const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);

					// Process ticket responses
					for (let i = 0; i < ticketChunk.length; i++) {
						const ticket = ticketChunk[i];
						if (ticket.status === 'error') {
							console.error(`Push notification error:`, ticket.message);

							// Handle expired or invalid tokens
							if (ticket.details && ticket.details.error === 'DeviceNotRegistered' && chunk[i].to) {
								const invalidToken = chunk[i].to as string;
								console.log(`Removing invalid token: ${invalidToken}`);

								// Remove invalid token from database
								await this.removeInvalidToken(supabase, invalidToken);
							}
						}
					}
				} catch (error) {
					console.error('Error sending push notifications:', error);
				}
			}
		} catch (error) {
			console.error('Unexpected error in sendPushNotifications:', error);
		}
	}

	/**
	 * Removes an invalid token from the database
	 */
	private async removeInvalidToken(supabase: any, token: string): Promise<void> {
		try {
			const { error } = await supabase.from('notification_tokens').delete().eq('push_token', token);

			if (error) {
				console.error('Error removing invalid token:', error);
			}
		} catch (error) {
			console.error('Unexpected error removing invalid token:', error);
		}
	}
}
