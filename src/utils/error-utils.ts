import axios from 'axios';

export interface ErrorResponse {
	data: {
		error: string;
		details?: string;
	};
	status: number;
}

// Standardized error handling
export const handleError = (error: unknown, context: string): ErrorResponse => {
	console.error(`Error in ${context}:`, error);

	if (axios.isAxiosError(error)) {
		if (error.response) {
			return {
				data: {
					error: `Failed in ${context}`,
					details: JSON.stringify(error.response.data),
				},
				status: error.response.status,
			};
		} else if (error.request) {
			return {
				data: {
					error: `Request failed in ${context}`,
					details: 'No response received',
				},
				status: 500,
			};
		}
	}

	return {
		data: {
			error: `Failed in ${context}`,
			details: error instanceof Error ? error.message : 'Unknown error',
		},
		status: 500,
	};
};
