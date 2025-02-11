# Stu Workers

A Cloudflare Worker that demonstrates a variety of features.


## Features

- `/fractal` Generates Mandelbrot and Julia set fractals
- `/ndjson-to-json` NDJSON to JSON conversion endpoint (limited to certain hostnames)
- `/xml-to-json` XML to JSON conversion endpoint (limited to certain hostnames)

## Endpoints

### /fractal

![example](preview/fractal-720x432.png)

Generates fractals (Mandelbrot and Julia sets) on demand. The worker creates grayscale images in either BMP or PNG format.

#### Parameters
- `width`: Image width (default: 720, max: 800 for BMP, 320 for PNG)
- `height`: Image height (default: 432, max: 600 for BMP, 200 for PNG)
- `seed`: Random seed for reproducible generation (default: random)
- `type`: Fractal type ('mandelbrot' or 'julia', default: random)
- `iter`: Number of iterations (default: 50)
- `bmp`: Use BMP format if 'true', PNG if 'false' (default: true)

### /status
Returns a simple status message indicating the worker is running

### /ndjson-to-json
Converts NDJSON to JSON format 

Some log streaming and event services use NDJSON format since it is streamable, does not require closing `}` at the end of the fole and is human readable. 

NDJSON is seperated by newlines and each line is a JSON object.

Example NDJSON:
```json
{"key1":"value1"}
{"key2":"value2"}
```

Compare to JSON:
```json
{"key1":"value1","key2":"value2"}
```

This endpoint expects a URL which returns JSON returns this as JSON.


## Examples 

### Fractal Generation
- BMP format: /fractal?width=800&height=600&seed=12345&type=mandelbrot&iter=100
- PNG format: /fractal?width=320&height=200&seed=67890&type=julia&iter=50&bmp=false

### Status Check
GET /status

### NDJSON Conversion
- /ndjson-to-json?url=https://ntfy.sh/FdKwILjQxxHWZ26u/json?poll=1&since=1h

## Limitations
- The BMP format is limited to 800x600 pixels
- The PNG format is limited to 320x200 pixels
- The number of iterations is limited to 800
- You may be rate limited, please do not abuse the service.

## Running Locally

To run this project locally, follow these steps:

1. **Install Wrangler CLI** if you haven't already:
   ```bash
   npm install -g wrangler
   ```

2. **Clone the repository** and install dependencies:
   ```bash
   git clone <repository-url>
   cd stu-fractal-worker
   npm install
   ```

3. **Start the development server**:
   ```bash
   wrangler dev
   ```

This will start a local development server, typically at `http://127.0.0.1:8787`. Any changes you make to the code will be automatically reflected.

