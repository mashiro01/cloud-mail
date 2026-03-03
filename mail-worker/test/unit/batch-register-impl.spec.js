import { describe, it, expect } from 'vitest';
import { batchRegisterImpl } from '../../src/service/batch-register-service';
import { mulberry32 } from '../../src/utils/regex-gen';

describe('batchRegisterImpl', () => {
	it('returns fewer than n with exhausted_attempts when collisions dominate', async () => {
		const rng = mulberry32(1);

		const existing = new Set();
		const createCalls = [];

		const res = await batchRegisterImpl(
			{
				n: 5,
				// Deterministic collision: always generates the same local-part.
				rules: ['u00'],
				domainList: ['example.com'],
				passwordLen: 8,
				maxAttempts: 5, // intentionally too small
				maxRepeat: 16,
				maxOutputLen: 64,
				minEmailPrefix: 1,
				emailPrefixFilter: [],
			},
			{
				rng,
				isEmailTaken: async (email) => existing.has(email.toLowerCase()),
				isEmailDeleted: async () => false,
				createAccount: async ({ email, password }) => {
					existing.add(email.toLowerCase());
					createCalls.push({ email, password });
					return { email, password };
				},
			}
		);

		expect(res.requested).toBe(5);
		expect(res.created).toBeLessThan(5);
		expect(res.accounts).toHaveLength(res.created);
		expect(res.failures.some((f) => f.reason_code === 'exhausted_attempts')).toBe(true);
	});
});
