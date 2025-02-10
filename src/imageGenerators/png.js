export function createMinimalPNG(width, height, pixelData) {
    const crc32 = (buf) => {
        const table = new Uint32Array(256).map((_, i) => {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            return c;
        });
        let crc = ~0;
        for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
        return ~crc >>> 0;
    };

    const adler32 = (buf) => {
        let a = 1, b = 0;
        for (const byte of buf) {
            a = (a + byte) % 65521;
            b = (b + a) % 65521;
        }
        return (b << 16) | a;
    };

    const toBigEndian = (num) => {
        const arr = new Uint8Array(4);
        arr[0] = (num >> 24) & 0xff;
        arr[1] = (num >> 16) & 0xff;
        arr[2] = (num >> 8) & 0xff;
        arr[3] = num & 0xff;
        return arr;
    };

    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new Uint8Array([
        ...toBigEndian(13), // Chunk length
        ...[73, 72, 68, 82], // 'IHDR'
        ...toBigEndian(width),
        ...toBigEndian(height),
        8, // Bit depth (8-bit)
        0, // Color type (grayscale)
        0, // Compression
        0, // Filter
        0, // Interlace
    ]);
    const headerCRC = toBigEndian(crc32(header.slice(4)));

    // PNG requires each row to be prefixed with a filter byte (0 for none)
    const scanlines = new Uint8Array(width * height + height);
    for (let y = 0; y < height; y++) {
        scanlines[y * (width + 1)] = 0; // No filter
        scanlines.set(pixelData.slice(y * width, (y + 1) * width), y * (width + 1) + 1);
    }

    // zlib compression (uncompressed block)
    const zlibHeader = new Uint8Array([0x78, 0x01]); // DEFLATE with no compression
    const blockHeader = new Uint8Array([
        0x01, // Final block flag + Type 00 (no compression)
        scanlines.length & 0xFF,
        (scanlines.length >> 8) & 0xFF,
        (~scanlines.length & 0xFF),
        (~(scanlines.length >> 8) & 0xFF),
    ]);

    const deflate = new Uint8Array([
        ...zlibHeader,
        ...blockHeader,
        ...scanlines,
        ...toBigEndian(adler32(scanlines))
    ]);

    const dataChunk = new Uint8Array([
        ...toBigEndian(deflate.length),
        ...[73, 68, 65, 84], // 'IDAT'
        ...deflate,
        ...toBigEndian(crc32(new Uint8Array([73, 68, 65, 84, ...deflate])))
    ]);

    const endChunk = new Uint8Array([
        ...toBigEndian(0), // Length
        ...[73, 69, 78, 68], // 'IEND'
        ...toBigEndian(crc32(new Uint8Array([73, 69, 78, 68])))
    ]);

    return new Uint8Array([...signature, ...header, ...headerCRC, ...dataChunk, ...endChunk]);
} 