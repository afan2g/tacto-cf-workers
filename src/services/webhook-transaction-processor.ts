import { ethers } from 'ethers';
import { Provider, utils, types } from 'zksync-ethers';
import { createSupabaseClient } from './supabase';
import { NotificationService } from './notification';
import { ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS } from '../utils/constants';

// Define types for better code structure
export interface NotificationMessage {
	title: string;
	body: string;
	data?: Record<string, any>;
}

export interface TransactionActivity {
	category: string;
	asset: string;
	fromAddress: string;
	toAddress: string;
	value: number;
	hash: string;
}

export interface TransactionDetails {
	mainTransfer: TransactionActivity | null;
	totalFees: number;
}

export interface Profile {
	id: string;
	username: string;
	// Add other profile fields as needed
}

export class TransactionProcessor {
	private provider: Provider;
	private supabaseUrl: string;
	private supabaseServiceKey: string;
	private expoAccessToken: string;

	constructor(supabaseUrl: string, supabaseServiceKey: string, expoAccessToken: string) {
		this.provider = Provider.getDefaultProvider(types.Network.Sepolia);
		this.supabaseUrl = supabaseUrl;
		this.supabaseServiceKey = supabaseServiceKey;
		this.expoAccessToken = expoAccessToken;
	}

	/**
	 * Parses transaction details from Alchemy webhook data
	 * @param activities Array of transaction activities
	 * @returns Parsed transaction details
	 */
	parseTransactionDetails(activities: TransactionActivity[]): TransactionDetails {
		if (!Array.isArray(activities) || activities.length === 0) {
			return { mainTransfer: null, totalFees: 0 };
		}

		// Find the main token transfer
		const mainTransfer = activities.find(
			(activity) =>
				activity.category !== 'external' &&
				activity.asset !== 'ETH' &&
				activity.fromAddress !== utils.BOOTLOADER_FORMAL_ADDRESS &&
				activity.toAddress !== utils.BOOTLOADER_FORMAL_ADDRESS
		);

		if (!mainTransfer) {
			return { mainTransfer: null, totalFees: 0 };
		}

		// Calculate net ETH fee (amount sent to system contract minus amount returned)
		const ethFees = activities.filter((activity) => activity.asset === 'ETH');
		let totalFees = 0;

		for (const activity of ethFees) {
			if (activity.toAddress === utils.BOOTLOADER_FORMAL_ADDRESS) {
				totalFees += activity.value; // Fee paid to system
			} else if (activity.fromAddress === utils.BOOTLOADER_FORMAL_ADDRESS) {
				totalFees -= activity.value; // Refund from system
			}
		}

		return {
			mainTransfer,
			totalFees,
		};
	}

	/**
	 * Gets profile information from an Ethereum address
	 */
	async getProfileFromAddress(address: string): Promise<Profile | null> {
		try {
			const supabase = createSupabaseClient(this.supabaseUrl, this.supabaseServiceKey);
			const checksummedAddress = ethers.getAddress(address);

			const { data, error } = await supabase.from('wallets').select('owner_id').eq('address', checksummedAddress).maybeSingle();

			if (error) {
				console.error('Error fetching wallet:', error);
				return null;
			}

			if (!data) {
				return null;
			}

			const { data: profileData, error: profileError } = await supabase.from('profiles').select('*').eq('id', data.owner_id).maybeSingle();

			if (profileError) {
				console.error('Error fetching profile:', profileError);
				return null;
			}

			if (!profileData) {
				return null;
			}

			console.log('Profile found for address:', address);
			return profileData as Profile;
		} catch (error) {
			console.error('Error in getProfileFromAddress:', error);
			return null;
		}
	}

	/**
	 * Processes a transaction and updates the database
	 * @param transactionDetails Parsed transaction details
	 * @returns Success status
	 */
	async processTransaction(transactionDetails: TransactionDetails): Promise<boolean> {
		const { mainTransfer, totalFees } = transactionDetails;
		const supabase = createSupabaseClient(this.supabaseUrl, this.supabaseServiceKey);
		const notificationService = new NotificationService(this.expoAccessToken);

		if (!mainTransfer) {
			return false;
		}

		try {
			// Get user profiles in parallel
			const [fromUser, toUser] = await Promise.all([
				this.getProfileFromAddress(mainTransfer.fromAddress),
				this.getProfileFromAddress(mainTransfer.toAddress),
			]);

			if (!fromUser && !toUser) {
				return false;
			}

			const { data: existingTx, error: findError } = await supabase
				.from('transactions')
				.select('*')
				.eq('hash', mainTransfer.hash)
				.maybeSingle();

			if (findError) {
				console.error('Error checking for existing transaction:', findError);
				return false;
			}

			// If existing transaction is found, update it
			if (existingTx) {
				const { error: updateError } = await supabase
					.from('transactions')
					.update({
						amount: mainTransfer.value,
						status: 'confirmed',
						fee: totalFees,
						updated_at: new Date().toISOString(),
					})
					.eq('hash', mainTransfer.hash);

				if (updateError) {
					console.error('Failed to update transaction record:', updateError);
					return false;
				}

				// Send notification if recipient is a known user
				if (toUser) {
					//fromUser exists, toUser exists
					const senderName = fromUser?.username || mainTransfer.fromAddress.slice(0, 6) + '...' + mainTransfer.fromAddress.slice(-4);

					let title, body;

					if (existingTx.request_id) {
						title = 'Payment Fulfilled';
						body = `${senderName} fulfilled your request of $${
							mainTransfer.value % 1 == 0 ? mainTransfer.value.toFixed(0) : mainTransfer.value.toFixed(2)
						}`;
					} else {
						title = 'Payment Received';
						body = `${senderName} sent you a payment of $${
							mainTransfer.value % 1 == 0 ? mainTransfer.value.toFixed(0) : mainTransfer.value.toFixed(2)
						}`;
					}

					const [pushNotificationResponse, fromETHBalance, fromUSDCBalance, toETHBalance, toUSDCBalance] = await Promise.all([
						notificationService.sendPushNotifications(
							[toUser.id],
							{
								title: title,
								body: body,
								data: {
									type: existingTx.type,
									hash: mainTransfer.hash,
									token: mainTransfer.asset,
									amount: mainTransfer.value,
									fee: totalFees,
									fromAddress: mainTransfer.fromAddress,
									toAddress: mainTransfer.toAddress,
								},
							},
							supabase
						),
						this.provider.getBalance(mainTransfer.fromAddress),
						this.provider.getBalance(mainTransfer.fromAddress, 'committed', ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS),
						this.provider.getBalance(mainTransfer.toAddress),
						this.provider.getBalance(mainTransfer.toAddress, 'committed', ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS),
					]);

					const { error: updateFromBalanceError } = await supabase
						.from('wallets')
						.update({
							eth_balance: ethers.formatEther(fromETHBalance),
							usdc_balance: ethers.formatUnits(fromUSDCBalance, 6),
						})
						.eq('address', ethers.getAddress(mainTransfer.fromAddress));

					const { error: updateToBalanceError } = await supabase
						.from('wallets')
						.update({
							eth_balance: ethers.formatEther(toETHBalance),
							usdc_balance: ethers.formatUnits(toUSDCBalance, 6),
						})
						.eq('address', ethers.getAddress(mainTransfer.toAddress));

					if (updateFromBalanceError || updateToBalanceError) {
						console.error('Failed to update wallet balances:', updateFromBalanceError, updateToBalanceError);
						return false;
					}
				} else if (fromUser) {
					//fromUser exists, toUser doesnt exist
					// This is a transaction sent from a known user to an external address

					const [ethBalance, usdcBalance] = await Promise.all([
						this.provider.getBalance(mainTransfer.fromAddress),
						this.provider.getBalance(mainTransfer.fromAddress, 'committed', ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS),
					]);

					const { error: updateBalanceError } = await supabase
						.from('wallets')
						.update({
							eth_balance: ethers.formatEther(ethBalance),
							usdc_balance: ethers.formatUnits(usdcBalance, 6),
						})
						.eq('address', ethers.getAddress(mainTransfer.fromAddress));

					if (updateBalanceError) {
						console.error('Failed to update balances:', updateBalanceError);
						return false;
					}
				}
			} else if (toUser) {
				//fromUser doesnt exist, toUser exists
				// This is a transaction sent from an external address to a known user
				const { error: insertError } = await supabase.from('transactions').insert({
					to_user_id: toUser.id,
					status: 'confirmed',
					hash: mainTransfer.hash,
					from_address: ethers.getAddress(mainTransfer.fromAddress),
					to_address: ethers.getAddress(mainTransfer.toAddress),
					amount: mainTransfer.value,
					asset: mainTransfer.asset,
					fee: totalFees,
					method_id: 5, // Consider making this dynamic
				});

				if (insertError) {
					console.error('Failed to insert transaction record:', insertError);
					return false;
				}

				// Format the sender address for display
				const senderDisplay = mainTransfer.fromAddress.slice(0, 6) + '...' + mainTransfer.fromAddress.slice(-4);

				//update the balance of the receiver
				const [ethBalance, usdcBalance] = await Promise.all([
					this.provider.getBalance(mainTransfer.toAddress),
					this.provider.getBalance(mainTransfer.toAddress, 'committed', ZKSYNC_SEPOLIA_USDC_CONTRACT_ADDRESS),
				]);

				const { error: updateBalanceError } = await supabase
					.from('wallets')
					.update({
						eth_balance: ethers.formatEther(ethBalance),
						usdc_balance: ethers.formatUnits(usdcBalance, 6),
					})
					.eq('address', ethers.getAddress(mainTransfer.toAddress));

				if (updateBalanceError) {
					console.error('Failed to update wallet balance:', updateBalanceError);
					return false;
				}

				// Send notification to the receiver
				await notificationService.sendPushNotifications(
					[toUser.id],
					{
						title: 'Payment Received',
						body: `You received ${mainTransfer.value} ${mainTransfer.asset} from ${senderDisplay}`,
						data: {
							type: 'transfer',
							hash: mainTransfer.hash,
							token: mainTransfer.asset,
							amount: mainTransfer.value,
							fee: totalFees,
							fromAddress: mainTransfer.fromAddress,
							toAddress: mainTransfer.toAddress,
						},
					},
					supabase
				);
			}

			return true;
		} catch (error) {
			console.error('Error processing transaction:', error);
			return false;
		}
	}
}
