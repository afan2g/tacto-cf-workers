import { Hono } from 'hono';
import { Secrets, Variables } from '../types';
import { NotificationMessage, NotificationService } from '../services/notification';
import { Friendship } from '../types/Friendship';
export const registerFriendRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Error handling utility function - returns a response object
	const createErrorResponse = (error: Error, customMessage = 'Internal server error') => {
		console.error(customMessage + ':', error);
		return {
			error: customMessage,
			details: error instanceof Error ? error.message : 'Unknown error',
		};
	};

	// Helper function to send notifications with error handling
	const sendNotification = async (recipients: string[], message: NotificationMessage, supabase: any, accessToken: string) => {
		try {
			const notificationService = new NotificationService(accessToken);
			await notificationService.sendPushNotifications(recipients, message, supabase);
			return true;
		} catch (error) {
			console.error('Failed to send notification:', error);
			return false;
		}
	};

	app.post('/friends/add', async (c) => {
		try {
			const requester = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');
			const { requestee } = await c.req.json();

			// Validate requestee
			if (!requestee || typeof requestee !== 'string') {
				return c.json({ error: 'Invalid requestee' }, 400);
			}

			// Prevent self-friending
			if (requester.id === requestee) {
				return c.json({ error: 'Cannot send friend request to yourself' }, 400);
			}

			// Search for existing relationship in both directions
			const { data: existingRelationship, error: relationshipError } = await supabase
				.from('friends')
				.select('*')
				.or(
					`and(requester_id.eq.${requester.id},requestee_id.eq.${requestee}),and(requester_id.eq.${requestee},requestee_id.eq.${requester.id})`
				)
				.maybeSingle();

			if (relationshipError && relationshipError.code !== 'PGRST116') {
				console.error('Error checking relationship:', relationshipError);
				return c.json(createErrorResponse(relationshipError, 'Error checking relationship'), 500);
			}

			// Handle based on existing relationship status
			if (existingRelationship) {
				switch (existingRelationship.status) {
					case 'accepted':
						return c.json({ error: 'Already friends' }, 400);

					case 'pending':
						// If request is already pending from the same direction
						if (existingRelationship.requester_id === requester.id) {
							return c.json({ error: 'Friend request already sent' }, 400);
						}

						// If there's a pending request from the other person, auto-accept it
						const { data: updatedFriendship, error: updateError } = await supabase
							.from('friends')
							.update({ status: 'accepted', updated_at: new Date() })
							.eq('id', existingRelationship.id)
							.select()
							.single();

						if (updateError) {
							console.error('Error accepting friend request:', updateError);
							return c.json(createErrorResponse(updateError, 'Error accepting friend request'), 500);
						}

						// Send notification about the accepted request
						await sendNotification(
							[requestee],
							{
								title: 'Friend Request Accepted',
								body: `${profile.username} accepted your friend request`,
								data: {
									type: 'friend_accepted',
									friendshipId: updatedFriendship.id,
								},
							},
							supabase,
							c.env.EXPO_ACCESS_TOKEN
						);

						return c.json({ message: 'Friend request accepted', data: updatedFriendship });

					case 'declined':
					case 'canceled':
						// Reactivate the declined/canceled request
						const { data: reactivatedFriendship, error: reactivateError } = await supabase
							.from('friends')
							.update({
								status: 'pending',
								updated_at: new Date(),
								// Flip the direction if necessary
								requester_id: requester.id,
								requestee_id: requestee,
							})
							.eq('id', existingRelationship.id)
							.select()
							.single();

						if (reactivateError) {
							console.error('Error reactivating friend request:', reactivateError);
							return c.json(createErrorResponse(reactivateError, 'Error reactivating friend request'), 500);
						}

						// Send notification about the new request
						await sendNotification(
							[requestee],
							{
								title: 'New Friend Request',
								body: `${profile.username} has sent you a friend request`,
								data: {
									type: 'friend_request',
									requestId: reactivatedFriendship.id,
								},
							},
							supabase,
							c.env.EXPO_ACCESS_TOKEN
						);

						return c.json({ message: 'Friend request sent', data: reactivatedFriendship });
				}
			}

			// Insert new friend request
			const { data, error: insertError } = await supabase
				.from('friends')
				.insert([
					{
						requester_id: requester.id,
						requestee_id: requestee,
						status: 'pending',
					},
				])
				.select()
				.single();

			if (insertError) {
				console.error('Error creating friend request:', insertError);
				return c.json(createErrorResponse(insertError, 'Error creating friend request'), 500);
			}

			// Send notification to the requestee
			await sendNotification(
				[requestee],
				{
					title: 'New Friend Request',
					body: `${profile.username} has sent you a friend request`,
					data: {
						type: 'friend_request',
						requestId: data.id,
					},
				},
				supabase,
				c.env.EXPO_ACCESS_TOKEN
			);

			return c.json({ message: 'Friend request sent', data });
		} catch (error) {
			console.error('Error processing friend request:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing friend request'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Decline a friend request (requestee declines requester's request)
	app.post('/friends/decline', async (c) => {
		try {
			const user = c.get('user');
			const supabase = c.get('supabase');
			const { requestId } = await c.req.json();

			// Validate requestId
			if (!requestId || typeof requestId !== 'string') {
				return c.json({ error: 'Invalid requestId' }, 400);
			}

			// Check if the friendship exists and is pending
			const { data: existingFriendship, error: fetchError } = await supabase
				.from('friends')
				.select('*')
				.eq('id', requestId)
				.eq('requestee_id', user.id)
				.eq('status', 'pending')
				.single();

			if (fetchError) {
				console.error('Error fetching friendship for decline:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friendship'), 500);
			}

			if (!existingFriendship) {
				return c.json({ error: 'Friendship not found or already processed' }, 404);
			}

			// Update the friendship status
			const { data: updatedFriendship, error: updateError } = await supabase
				.from('friends')
				.update({ status: 'declined', updated_at: new Date() })
				.eq('id', requestId)
				.select()
				.single();

			if (updateError) {
				console.error('Error declining friend request:', updateError);
				return c.json(createErrorResponse(updateError, 'Error declining friend request'), 500);
			}

			return c.json({ message: 'Friend request declined', data: updatedFriendship });
		} catch (error) {
			console.error('Error processing decline request:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing decline request'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Cancel a friend request (requester cancels their own request)
	app.post('/friends/cancel', async (c) => {
		try {
			const user = c.get('user');
			const supabase = c.get('supabase');
			const { requestId } = await c.req.json();

			// Validate requestId
			if (!requestId || typeof requestId !== 'string') {
				return c.json({ error: 'Invalid requestId' }, 400);
			}

			// Check if the friendship exists and is pending
			const { data: existingFriendship, error: fetchError } = await supabase
				.from('friends')
				.select('*')
				.eq('id', requestId)
				.eq('requester_id', user.id)
				.eq('status', 'pending')
				.single();

			if (fetchError) {
				console.error('Error fetching friendship for cancel:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friendship'), 500);
			}

			if (!existingFriendship) {
				return c.json({ error: 'Friendship not found or already processed' }, 404);
			}

			// Update the friendship status
			const { data: updatedFriendship, error: updateError } = await supabase
				.from('friends')
				.update({ status: 'canceled', updated_at: new Date() })
				.eq('id', requestId)
				.select()
				.single();

			if (updateError) {
				console.error('Error canceling friend request:', updateError);
				return c.json(createErrorResponse(updateError, 'Error canceling friend request'), 500);
			}

			return c.json({ message: 'Friend request canceled', data: updatedFriendship });
		} catch (error) {
			console.error('Error processing cancel request:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing cancel request'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Accept a friend request
	app.post('/friends/accept', async (c) => {
		try {
			const user = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');
			const body = await c.req.json();
			const { requestId } = body;

			// Validate requestId
			if (!requestId || typeof requestId !== 'string') {
				return c.json({ error: 'Invalid requestId' }, 400);
			}

			// Check if the friendship exists and is pending
			const { data: existingFriendship, error: fetchError } = await supabase
				.from('friends')
				.select('*')
				.eq('id', requestId)
				.eq('requestee_id', user.id)
				.eq('status', 'pending')
				.single();

			if (fetchError) {
				console.error('Error fetching friendship for accept:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friendship'), 500);
			}

			if (!existingFriendship) {
				return c.json({ error: 'Friendship not found or already processed' }, 404);
			}

			console.log('Existing friendship:', existingFriendship);
			// Update the friendship status
			const { data: updatedFriendship, error: updateError } = await supabase
				.from('friends')
				.update({ status: 'accepted', updated_at: new Date() })
				.eq('id', requestId)
				.select()
				.single();

			if (updateError) {
				console.error('Error accepting friend request:', updateError);
				return c.json(createErrorResponse(updateError, 'Error accepting friend request'), 500);
			}

			console.log('Updated friendship:', updatedFriendship);
			// Send notification to requester
			if (profile) {
				await sendNotification(
					[existingFriendship.requester_id],
					{
						title: 'Friend Request Accepted',
						body: `${profile.username} accepted your friend request`,
						data: {
							type: 'friend_accepted',
							friendshipId: updatedFriendship.id,
						},
					},
					supabase,
					c.env.EXPO_ACCESS_TOKEN
				);
			}

			return c.json({ message: 'Friend request accepted', data: updatedFriendship });
		} catch (error) {
			console.error('Error processing accept request:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing accept request'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Unfriend a user
	app.post('/friends/unfriend', async (c) => {
		try {
			const user = c.get('user');
			const supabase = c.get('supabase');
			const { friendId } = await c.req.json();

			// Validate friendId
			if (!friendId || typeof friendId !== 'string') {
				return c.json({ error: 'Invalid friendId' }, 400);
			}

			// Check if the friendship exists and is accepted
			const { data: existingFriendship, error: fetchError } = await supabase
				.from('friends')
				.select('*')
				.eq('id', friendId)
				.eq('status', 'accepted')
				.single();

			if (fetchError) {
				console.error('Error fetching friendship for unfriend:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friendship'), 500);
			}

			if (!existingFriendship) {
				return c.json({ error: 'Friendship not found or already ended' }, 404);
			}

			// Verify user is part of the friendship
			if (existingFriendship.requester_id !== user.id && existingFriendship.requestee_id !== user.id) {
				return c.json({ error: 'You are not part of this friendship' }, 403);
			}

			// Delete the friendship record
			const { error: deleteError } = await supabase.from('friends').delete().eq('id', existingFriendship.id);

			if (deleteError) {
				console.error('Error deleting friendship:', deleteError);
				return c.json(createErrorResponse(deleteError, 'Error deleting friendship'), 500);
			}

			return c.json({ message: 'Unfriended successfully' });
		} catch (error) {
			console.error('Error processing unfriend request:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing unfriend request'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Get pending friend requests for the current user
	app.get('/friends/requests', async (c) => {
		try {
			const user = c.get('user');
			const supabase = c.get('supabase');

			// Fetch all friend requests for the requestee
			const { data: requests, error: fetchError } = await supabase
				.from('friends')
				.select(
					`
					*,
					requester:requester_id(id, username, avatar_url)
				`
				)
				.eq('requestee_id', user.id)
				.eq('status', 'pending')
				.order('updated_at', { ascending: false });

			if (fetchError) {
				console.error('Error fetching friend requests:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friend requests'), 500);
			}

			return c.json({ data: requests });
		} catch (error) {
			console.error('Error processing get friend requests:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing get friend requests'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});

	// Get user's friends list (accepted friendships)
	app.get('/friends', async (c) => {
		try {
			const user = c.get('user');
			const supabase = c.get('supabase');

			// Fetch all active friendships for the user (either as requester or requestee)
			const { data: friendships, error: fetchError } = await supabase
				.from('friends')
				.select(
					`
					*,
					friend_user:requester_id(id, username, avatar_url),
					friend_user2:requestee_id(id, username, avatar_url)
				`
				)
				.or(`requester_id.eq.${user.id},requestee_id.eq.${user.id}`)
				.eq('status', 'accepted')
				.order('updated_at', { ascending: false });

			if (fetchError) {
				console.error('Error fetching friends:', fetchError);
				return c.json(createErrorResponse(fetchError, 'Error fetching friends'), 500);
			}

			// Transform the data to get a clean list of friends
			const friends = friendships.map((friendship: Friendship) => {
				// If the user is the requester, return the requestee as the friend
				if (friendship.requester_id === user.id) {
					return {
						friendship_id: friendship.id,
						user: friendship.requestee_id,
						since: friendship.updated_at,
					};
				}
				// If the user is the requestee, return the requester as the friend
				return {
					friendship_id: friendship.id,
					user: friendship.requester_id,
					since: friendship.updated_at,
				};
			});

			return c.json({ data: friends });
		} catch (error) {
			console.error('Error processing get friends:', error);
			if (error instanceof Error) {
				return c.json(createErrorResponse(error, 'Error processing get friends'), 500);
			}
			return c.json({ error: 'Unknown error' }, 500);
		}
	});
};
