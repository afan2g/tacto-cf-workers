import { Hono } from 'hono';
import { ethers } from 'ethers';
import { utils } from 'zksync-ethers';
import { broadcastTransaction, prepareTransferTransaction, checkUSDCBalance } from '../services/provider';
import { getNonceFromAlchemy } from '../services/alchemy';
import { insertTransaction, insertPaymentRequest } from '../services/supabase';
import { NotificationService } from '../services/notification';
import { Secrets, Variables } from '../types';
export const registerTransactionRoutes = (app: Hono<{ Bindings: Secrets; Variables: Variables }>) => {
	// Route: Broadcast USDC Transaction
	app.post('/transactions/send/broadcast-usdc', async (c) => {
		try {
			const { signedTransaction, txRequest, txInfo } = await c.req.json();

			// Validate required parameters
			if (!signedTransaction || !txRequest || !txInfo) {
				return c.json({ error: 'Missing required parameters for broadcastTxUSDC' }, 400);
			}

			// Validate txInfo fields
			if (!txInfo.toUserId || txInfo.methodId === undefined) {
				return c.json({ error: 'Missing required fields in txInfo' }, 400);
			}

			// Broadcast transaction
			const txResponseDetailedOutput = await broadcastTransaction(signedTransaction);
			console.log('broadcastTxUSDC. Transaction response:', txResponseDetailedOutput);

			// Format amount with error handling
			let formattedAmount = '0';
			try {
				// Safely handle undefined value
				const value = txRequest.value !== undefined ? txRequest.value : 0;
				formattedAmount = ethers.formatUnits(value ?? 0, 6); // USDC has 6 decimals
			} catch (error) {
				console.log('Error formatting amount:', error);
			}

			// Insert transaction record
			const user = c.get('user');
			const supabase = c.get('supabase');

			const transactionData = {
				from_user_id: user.id,
				to_user_id: txInfo.toUserId,
				from_address: txRequest.from,
				to_address: txRequest.to,
				amount: formattedAmount,
				method_id: txInfo.methodId,
				request_id: txInfo.requestId,
				hash: txResponseDetailedOutput.transactionHash,
				status: 'pending',
				asset: 'USDC',
				fee: 0, // Will be updated later after confirmation
				created_at: new Date().toISOString(),
			};

			const transactionRecord = await insertTransaction(supabase, transactionData);

			return c.json(
				utils.toJSON({
					...txResponseDetailedOutput,
					transaction_id: transactionRecord.id,
				})
			);
		} catch (error) {
			console.log('Error broadcasting USDC transaction:', error);
			return c.json(
				{
					error: 'Failed to broadcast USDC transaction',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	// Route: Get Complete Transfer Transaction
	app.post('/transactions/send/prepare-usdc', async (c) => {
		try {
			const { txRequest } = await c.req.json();

			if (!txRequest || !txRequest.from || !txRequest.to || !txRequest.value) {
				return c.json(
					{
						error: 'Invalid transaction request. Required: from, to, value',
					},
					400
				);
			}

			// Get USDC balance
			const usdcBalance = await checkUSDCBalance(txRequest.from);

			// Get nonce
			const nonce = await getNonceFromAlchemy(txRequest.from, c.env.ALCHEMY_API_KEY);

			// Check USDC balance
			const txValue = BigInt(txRequest.value.toString());
			if (usdcBalance < txValue) {
				return c.json(
					{
						error: 'Insufficient USDC balance',
						available: usdcBalance.toString(),
						required: txValue.toString(),
					},
					400
				);
			}

			// Prepare transaction
			const completeTransferTx = await prepareTransferTransaction(txRequest.from, txRequest.to, txValue, nonce);

			console.log('getCompleteTransferTx. Complete transfer transaction:', completeTransferTx);
			return c.json(utils.toJSON(completeTransferTx));
		} catch (error) {
			console.log('Error preparing transaction:', error);
			return c.json(
				{
					error: 'Failed to prepare transaction',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	app.post('/transactions/request/create', async (c) => {
		console.log('Creating payment request');
		try {
			// Get the request data directly, not nested under paymentRequest
			const { paymentRequest } = await c.req.json();

			console.log('Payment request data:', paymentRequest);
			// Check required fields on the main object
			if (!paymentRequest.amount || !paymentRequest.recipientUser?.id || paymentRequest.methodId === undefined) {
				console.log('Invalid payment request. recipient user:', paymentRequest.recipientUser?.id);
				console.log('Invalid payment request. method id:', paymentRequest.methodId);
				console.log('Invalid payment request. amount:', paymentRequest.amount);

				return c.json({ error: 'Missing required payment request fields' }, 400);
			}

			const user = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');

			const { data: requestee, error: requesteeError } = await supabase
				.from('profiles')
				.select('id')
				.eq('id', paymentRequest.recipientUser.id)
				.maybeSingle();

			if (requesteeError || !requestee) {
				return c.json({ error: 'Requestee not found' }, 400);
			}

			// Insert the payment request
			await insertPaymentRequest(supabase, {
				requester_id: user.id,
				requestee_id: requestee.id,
				amount: paymentRequest.amount,
				message: paymentRequest.message || '', // Use message directly from requestData
				status: 'pending',
			});

			// Send notification
			const notificationService = new NotificationService(c.env.EXPO_ACCESS_TOKEN);
			await notificationService.sendPushNotifications(
				[requestee.id],
				{
					title: 'Payment Request',
					body: `You have a new payment request from ${profile.full_name}`,
					data: {
						type: 'payment_request',
						amount: paymentRequest.amount,
						requesterId: user.id,
					},
				},
				supabase
			);

			return c.json({ success: true, message: 'Payment request created successfully' });
		} catch (error) {
			console.log('Error creating payment request:', error);
			return c.json(
				{
					error: 'Failed to create payment request',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	app.post('/transactions/request/fulfill', async (c) => {
		console.log('Fulfilling payment request');
		try {
			const { requestId, txRequest, signedTransaction } = await c.req.json();

			if (!requestId || !txRequest || !signedTransaction) {
				return c.json({ error: 'Missing required fields: requestId, txRequest, signedTransaction' }, 400);
			}

			const user = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');

			// 1. Fetch the payment request
			const { data: request, error: fetchError } = await supabase.from('payment_requests').select('*').eq('id', requestId).maybeSingle();

			if (fetchError || !request) {
				return c.json({ error: 'Payment request not found' }, 404);
			}

			// 2. Validate that the current user is the requestee
			if (request.requestee_id !== user.id) {
				return c.json({ error: 'You are not authorized to fulfill this request' }, 403);
			}

			// 3. Broadcast the transaction
			const txResponse = await broadcastTransaction(signedTransaction);
			console.log('Fulfilled transaction:', txResponse);

			// 4. Format the amount
			let formattedAmount = '0';
			try {
				formattedAmount = ethers.formatUnits(txRequest.value ?? 0, 6);
			} catch (e) {
				console.log('Error formatting value', e);
			}
			console.log('Txrequest', txRequest);
			console.log('txrequest value', txRequest.value);
			console.log('formatted amount', formattedAmount);
			// 5. Insert the transaction record
			const transactionData = {
				from_user_id: user.id,
				to_user_id: request.requester_id,
				from_address: txRequest.from,
				to_address: txRequest.to,
				amount: formattedAmount,
				method_id: 3, // Or set from context
				request_id: requestId,
				hash: txResponse.transactionHash,
				status: 'pending',
				asset: 'USDC',
				fee: 0,
				created_at: new Date().toISOString(),
			};

			const transactionRecord = await insertTransaction(supabase, transactionData);

			// 6. Mark the payment request as fulfilled
			await supabase
				.from('payment_requests')
				.update({
					status: 'completed',
					fulfilled_by: transactionRecord.id,
					updated_at: new Date().toISOString(),
				})
				.eq('id', requestId);

			return c.json(
				utils.toJSON({
					transaction_id: transactionRecord.id,
					transaction_hash: txResponse.transactionHash,
					status: 'completed',
				})
			);
		} catch (error) {
			console.log('Error fulfilling payment request:', error);
			return c.json(
				{
					error: 'Failed to fulfill payment request',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	app.post('/transactions/request/decline', async (c) => {
		console.log('Declining payment request');
		try {
			const { requestId } = await c.req.json();

			if (!requestId) {
				return c.json({ error: 'Missing required fields: requestId' }, 400);
			}

			const user = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');

			// 1. Fetch the payment request
			const { data: request, error: fetchError } = await supabase.from('payment_requests').select('*').eq('id', requestId).maybeSingle();

			if (fetchError || !request) {
				return c.json({ error: 'Payment request not found' }, 404);
			}

			// 2. Validate that the current user is the requestee
			if (request.requestee_id !== user.id) {
				return c.json({ error: 'You are not authorized to decline this request' }, 403);
			}

			// 3. Mark the payment request as declined
			await supabase
				.from('payment_requests')
				.update({
					status: 'declined',
					updated_at: new Date().toISOString(),
				})
				.eq('id', requestId);

			//send notification to the requester
			const notificationService = new NotificationService(c.env.EXPO_ACCESS_TOKEN);
			await notificationService.sendPushNotifications(
				[request.requester_id],
				{
					title: 'Payment Request',
					body: `Your payment request has been declined by ${profile.full_name}`,
					data: {
						type: 'payment_request',
						requestId: requestId,
					},
				},
				supabase
			);
			return c.json({ success: true, message: 'Payment request declined successfully' });
		} catch (error) {
			console.log('Error declining payment request:', error);
			return c.json(
				{
					error: 'Failed to decline payment request',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});

	app.post('/transactions/request/cancel', async (c) => {
		console.log('Cancelling payment request');
		try {
			const { requestId } = await c.req.json();

			if (!requestId) {
				return c.json({ error: 'Missing required fields: requestId' }, 400);
			}

			const user = c.get('user');
			const profile = c.get('profile');
			const supabase = c.get('supabase');

			// 1. Fetch the payment request
			const { data: request, error: fetchError } = await supabase.from('payment_requests').select('*').eq('id', requestId).maybeSingle();

			if (fetchError || !request) {
				return c.json({ error: 'Payment request not found' }, 404);
			}

			// 2. Validate that the current user is the requester
			if (request.requester_id !== user.id) {
				return c.json({ error: 'You are not authorized to cancel this request' }, 403);
			}

			// 3. Mark the payment request as cancelled
			await supabase
				.from('payment_requests')
				.update({
					status: 'canceled',
					updated_at: new Date().toISOString(),
				})
				.eq('id', requestId);

			//send notification to the requestee
			const notificationService = new NotificationService(c.env.EXPO_ACCESS_TOKEN);
			await notificationService.sendPushNotifications(
				[request.requestee_id],
				{
					title: 'Payment Request',
					body: `Your payment request has been cancelled by ${profile.full_name}`,
					data: {
						type: 'payment_request',
						requestId: requestId,
					},
				},
				supabase
			);
			return c.json({ success: true, message: 'Payment request cancelled successfully' });
		} catch (error) {
			console.log('Error cancelling payment request:', error);
			return c.json(
				{
					error: 'Failed to cancel payment request',
					details: error instanceof Error ? error.message : 'Unknown error',
				},
				500
			);
		}
	});
};
