import { DateTime } from 'luxon';

/**
 * API Key Validation Middleware
 * 
 * This middleware validates API keys with the following format:
 * stucal_randomstring_yyyy-MM-dd_signature
 * 
 * @param {Request} request - The incoming request
 * @param {Object} env - Environment variables
 * @returns {Object} - Returns { valid: boolean, error: string } 
 */
export async function validateApiKey(request, env) {
    try {
        // Skip validation if running locally
        if (env.ENVIRONMENT === 'development' || env.NODE_ENV === 'development') {
            console.log('Development environment detected, skipping validation');
            return { valid: true };
        }

        // Require MASTER_KEY to be set in environment for production
        if (!env.MASTER_KEY) {
            console.error('MASTER_KEY environment variable is not set in production');
            return { 
                valid: false,
                error: 'Server configuration error: Authentication is not properly configured'
            };
        }

        // Check for API key in header first, then URL parameter
        let apiKey = request.headers.get('X-API-Key');
        if (!apiKey) {
            const url = new URL(request.url);
            apiKey = url.searchParams.get('key');
            
            if (!apiKey) {
                return {
                    valid: false,
                    error: 'No API key provided in header or URL parameters'
                };
            }
        }
        
        // Split the key into its components
        const parts = apiKey.split('_');
        if (parts.length !== 4) {
            return {
                valid: false,
                error: 'Invalid API key format'
            };
        }
        
        const [prefix, random, expiry, providedSignature] = parts;
        
        // Validate prefix
        if (prefix !== 'stucal') {
            return {
                valid: false,
                error: 'Invalid API key prefix'
            };
        }
        
        // Check if key has expired
        const expiryDate = DateTime.fromFormat(expiry, 'yyyy-MM-dd');
        if (!expiryDate.isValid) {
            return {
                valid: false,
                error: 'Invalid expiry date format in API key'
            };
        }
        
        if (expiryDate < DateTime.now()) {
            return {
                valid: false,
                error: 'API key has expired'
            };
        }
        
        // Validate signature
        const keyContent = `${prefix}_${random}_${expiry}`;
        const encoder = new TextEncoder();
        const keyData = encoder.encode(env.MASTER_KEY.slice(0, 3));
        const messageData = encoder.encode(keyContent);
        
        const key = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        
        const signature = await crypto.subtle.sign(
            'HMAC',
            key,
            messageData
        );
        
        const expectedSignature = Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 8);
        
        if (expectedSignature !== providedSignature) {
            return {
                valid: false,
                error: 'Invalid API key signature'
            };
        }

        return { valid: true };
    } catch (error) {
        console.error('Validation error:', error.message);
        return {
            valid: false,
            error: error.message
        };
    }
}

/**
 * Middleware wrapper for API key validation
 * 
 * @param {Function} handler - The route handler to wrap
 * @returns {Function} - Returns a wrapped handler with API key validation
 */
export function withApiKeyValidation(handler) {
    return async (request, env, ctx) => {
        const { valid, error } = await validateApiKey(request, env);
        
        if (!valid) {
            const status = error.includes('No API key provided') ? 401 : 403;
            return new Response(JSON.stringify({ 
                error,
                details: 'Authentication failed'
            }), {
                status,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

        return handler(request, env, ctx);
    };
} 