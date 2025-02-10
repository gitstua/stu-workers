/**
 * Rate limiting module for Cloudflare Workers
 * 
 * This module provides rate limiting functionality using Cloudflare Workers KV storage.
 * It tracks requests per IP address (hashed for privacy) over a 1-hour window.
 * 
 * Dependencies:
 * - Requires a Cloudflare Workers KV namespace bound as RATE_LIMIT
 * - Uses Web Crypto API (available by default in Workers runtime)
 * 
 * Environment Variables:
 * - RATE_LIMIT_PER_IP: Optional. Number of requests allowed per IP per hour. 
 *                      Defaults to 200 if not set.
 */

export async function checkRateLimit(request, env) {
    const ip = request.headers.get('CF-Connecting-IP');
    const currentTime = Date.now();
    const hourInMillis = 60 * 60 * 1000;
    
    // Use environment variable RATE_LIMIT_PER_IP if set, otherwise default to 200
    const rateLimitPerIP = env.RATE_LIMIT_PER_IP ? parseInt(env.RATE_LIMIT_PER_IP) : 200;

    // Hash the IP address using SHA-256
    const encoder = new TextEncoder();
    const ipData = encoder.encode(ip);
    const hashBuffer = await crypto.subtle.digest('SHA-256', ipData);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Use the hashed IP as the key
    const key = `rate_limit:${hashHex}`;

    // Fetch the current count and timestamp from KV
    let data = await env.RATE_LIMIT.get(key, { type: 'json' });
    if (!data) {
        data = { count: 0, timestamp: currentTime };
    }

    // Check if the current hour has passed
    if (currentTime - data.timestamp > hourInMillis) {
        // Reset the count and timestamp
        data.count = 0;
        data.timestamp = currentTime;
    }

    // Check if the limit is exceeded
    if (data.count >= rateLimitPerIP) {
        return false;
    }

    // Increment the count
    data.count += 1;

    // Store the updated data back to KV
    await env.RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: hourInMillis / 1000 });

    return true;
} 