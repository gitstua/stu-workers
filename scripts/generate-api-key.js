require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH });

const crypto = require('crypto');

async function generateApiKey(expiry = '2025-12-31') {
    const MASTER_KEY = process.env.MASTER_KEY;
    if (!MASTER_KEY) {
        console.error('MASTER_KEY environment variable is not set');
        process.exit(1);
    }

    console.log('Generating key with:');
    console.log('- Environment:', process.env.NODE_ENV || 'development');
    console.log('- MASTER_KEY:', MASTER_KEY);
    console.log('- Expiry:', expiry);

    // Use current timestamp instead of random bytes
    const timestamp = Date.now().toString(16); // Convert to hex
    const prefix = 'stucal';
    
    // Create the key content
    const keyContent = `${prefix}_${timestamp}_${expiry}`;
    
    // Generate signature using Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(MASTER_KEY.slice(0, 3));
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
    
    // Convert to hex and take first 8 characters
    const signatureHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 8);
    
    // Combine everything into the final key
    return `${keyContent}_${signatureHex}`;
}

// If running directly (not imported)
if (require.main === module) {
    const expiry = process.argv[2] || '2025-12-31';
    generateApiKey(expiry).then(key => {
        console.log('\nGenerated API Key:', key);
    }).catch(error => {
        console.error('Error generating key:', error);
        process.exit(1);
    });
}

module.exports = generateApiKey; 