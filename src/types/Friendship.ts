export interface Friendship {
	id: string;
	requester_id: string;
	requestee_id: string;
	status: 'pending' | 'accepted' | 'rejected' | 'blocked';
	created_at: string;
	updated_at: string;
}
