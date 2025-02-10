import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new Request('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});
});

describe('Fractal Worker', () => {
	it('should return status message', async () => {
		const response = await SELF.fetch('http://localhost/status');
		expect(await response.text()).toBe('Worker is running');
		expect(response.status).toBe(200);
	});

	it('should generate fractal image (BMP)', async () => {
		const response = await SELF.fetch('http://localhost/fractal?width=100&height=100');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/bmp');
	});

	it('should generate fractal image (PNG)', async () => {
		const response = await SELF.fetch('http://localhost/fractal?width=100&height=100&bmp=false');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
	});

	it('should convert NDJSON to JSON', async () => {
		const ndjson = '{"key1":"value1"}\n{"key2":"value2"}';
		const response = await SELF.fetch('http://localhost/ndjson-to-json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-ndjson' },
			body: ndjson
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ key1: 'value1' }, { key2: 'value2' }]);
	});

	it('should return 404 for unknown routes', async () => {
		const response = await SELF.fetch('http://localhost/unknown');
		expect(response.status).toBe(404);
	});
});
