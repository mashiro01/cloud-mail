import { describe, it, expect } from 'vitest';
import { generateFromRule, mulberry32 } from '../../src/utils/regex-gen';

describe('regex-gen', () => {
	it('generates from alternation + charclass + quantifier', () => {
		const rng = mulberry32(123);
		const s = generateFromRule('(dev|test)[a-z0-9]{4}', rng, {
			maxRepeat: 16,
			maxOutputLen: 64,
		});

		expect(s).toMatch(/^(dev|test)[a-z0-9]{4}$/);
	});
});
