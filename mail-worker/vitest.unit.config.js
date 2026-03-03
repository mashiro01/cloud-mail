import { defineConfig } from 'vitest/config';

// Unit-test config that avoids the Cloudflare Workers pool (wrangler/miniflare).
// Use this for pure logic tests that don't need `cloudflare:test`.
export default defineConfig({
	test: {
		environment: 'node',
	},
});

