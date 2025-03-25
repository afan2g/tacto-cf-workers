import { createClient } from '@supabase/supabase-js';

export const createSupabaseClient = (url: string, key: string) => {
	return createClient(url, key);
};

export const insertTransaction = async (supabase: any, transactionData: any) => {
	const { data, error } = await supabase.from('transactions').insert(transactionData).select().single();

	if (error) {
		console.log('Failed to insert transaction record', error);
		throw new Error(`Failed to insert transaction record: ${error.message}`);
	}

	return data;
};

export const insertPaymentRequest = async (supabase: any, paymentRequestData: any) => {
	const { error } = await supabase.from('payment_requests').insert(paymentRequestData);

	if (error) {
		console.log('Failed to insert payment request record', error);
		throw new Error(`Failed to insert payment request record: ${error.message}`);
	}
};

export const getProfileFromAddress = async (supabase: any, address: string) => {
	const { data, error } = await supabase
		.from('wallets')
		.select(
			`
				*,
				user_profile:profiles!owner_id(*)
			`
		)
		.eq('address', address)
		.maybeSingle();

	if (error) {
		console.log('Failed to get profile from address', error);
		throw new Error(`Failed to get profile from address: ${error.message}`);
	}
	return data;
};
