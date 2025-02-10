export function createMinimalBMP(width, height, pixelData) {
    const rowSize = Math.floor((width * 8 + 31) / 32) * 4;
    const imageSize = rowSize * height;
    const paletteSize = 256 * 4;
    const headerSize = 54;
    const fileSize = headerSize + paletteSize + imageSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // BMP Header
    view.setUint16(0, 0x4D42, true);
    view.setUint32(2, fileSize, true);
    view.setUint32(6, 0, true);
    view.setUint32(10, headerSize + paletteSize, true);

    // DIB Header
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, -height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 8, true);
    view.setUint32(30, 0, true);
    view.setUint32(34, imageSize, true);
    view.setInt32(38, 2835, true);
    view.setInt32(42, 2835, true);
    view.setUint32(46, 256, true);
    view.setUint32(50, 256, true);

    // Grayscale color palette
    for (let i = 0; i < 256; i++) {
        const offset = headerSize + i * 4;
        view.setUint8(offset, i);
        view.setUint8(offset + 1, i);
        view.setUint8(offset + 2, i);
        view.setUint8(offset + 3, 0);
    }

    // Pixel data
    const dataOffset = headerSize + paletteSize;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            view.setUint8(dataOffset + y * rowSize + x, pixelData[y * width + x]);
        }
        for (let x = width; x < rowSize; x++) {
            view.setUint8(dataOffset + y * rowSize + x, 0);
        }
    }

    return new Uint8Array(buffer);
} 