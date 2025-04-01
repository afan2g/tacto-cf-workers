import { User } from './User';
import { Profile } from './Profile';
import { Friendship } from './Friendship';
export interface Variables {
	user: User;
	profile: Profile;
	friendship: Friendship;
	supabase: any;
	jsonBody: any;
}
