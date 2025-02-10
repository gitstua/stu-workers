/**
 * Fractal generation module for Mandelbrot and Julia sets
 * 
 * This module generates grayscale fractal images as pixel data arrays.
 * It supports both Mandelbrot and Julia set fractals with randomized parameters.
 * 
 * Parameters:
 * - width: Image width in pixels
 * - height: Image height in pixels  
 * - maxIter: Maximum iterations for escape-time calculation (affects detail level)
 * - seed: Random seed to generate consistent parameters
 * - fractalType: Either 'mandelbrot' or 'julia'
 *
 * Returns:
 * - Uint8Array containing grayscale pixel data (0-255 values)
 */

export function generateFractal(width, height, maxIter, seed, fractalType) {
    const pixelData = new Uint8Array(width * height);
    
    // Simple random number generator with seed
    const random = (() => {
        let state = seed;
        return () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 0xFFFFFFFF;
        };
    })();
    
    // Parameters that vary with seed and fractal type
    const zoom = 2.8 + random() * 0.8;
    let centerX = -0.65 + (random() - 0.5) * 0.3;
    let centerY = (random() - 0.5) * 0.3;

    // Julia set parameters
    const juliaX = -0.4 + random() * 0.8;
    const juliaY = -0.4 + random() * 0.8;

    // Adjust parameters based on fractal type
    if (fractalType === 'julia') {
        centerX = 0;
        centerY = 0;
    }

    // Generate fractal
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let zx = 0, zy = 0;
            const cx = (x - width / 2) * zoom / width + centerX;
            const cy = (y - height / 2) * zoom / height + centerY;

            // Initialize based on fractal type
            if (fractalType === 'julia') {
                zx = cx;
                zy = cy;
            }

            let i = 0;
            while (zx * zx + zy * zy <= 4 && i < maxIter) {
                let temp;
                switch (fractalType) {
                    case 'julia':
                        temp = zx * zx - zy * zy + juliaX;
                        zy = 2 * zx * zy + juliaY;
                        zx = temp;
                        break;

                    case 'burningship':
                        temp = zx * zx - zy * zy + cx;
                        zy = Math.abs(2 * zx * zy) + cy;
                        zx = temp;
                        break;

                    default: // mandelbrot
                        temp = zx * zx - zy * zy + cx;
                        zy = 2 * zx * zy + cy;
                        zx = temp;
                }
                i++;
            }
            
            // Simple grayscale coloring
            if (i === maxIter) {
                pixelData[y * width + x] = 0; // Black for points inside set
            } else {
                // Basic gradient
                pixelData[y * width + x] = Math.floor(255 * Math.sqrt(i / maxIter));
            }
        }
    }

    return pixelData;
} 