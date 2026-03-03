import { describe, it, expect } from 'vitest';
import { generateFromRule, mulberry32 } from '../../src/utils/regex-gen';

describe('regex-gen', () => {
	it('generates from alternation + charclass + quantifier', () => {
		const rng = mulberry32(123);
		const s = generateFromRule('(dev|test)[a-z0-9]{4}', rng, {
			maxRepeat: 16,
			maxOutputLen: 64,
		});

		expect(s.length).toBe(3 + 4); // dev/test + 4
		expect(['dev', 'test']).toContain(s.slice(0, 4));
		expect(s.slice(-4)).toMatch(/^[a-z0-9]{4}$/);
	});
});
