/**
 * Fractal image generation API using Cloudflare Workers
 * 
 * This worker generates grayscale fractal images (Mandelbrot and Julia sets)
 * with configurable parameters via URL query strings:
 * 
 * - seed: Random seed for consistent results (default: random)
 * - type: 'mandelbrot' or 'julia' (default: random)
 * - width: Image width in pixels (max 800 for BMP, 320 for PNG)
 * - height: Image height in pixels (max 600 for BMP, 200 for PNG) 
 * - iter: Maximum iterations for detail level (default: 50, max: 800)
 * - bmp: Use BMP format if 'true', PNG if 'false' (default: true)
 * 
 * Rate limiting is applied per IP address to prevent abuse.
 * 
 * Dependencies:
 * - Cloudflare Workers KV namespace bound as RATE_LIMIT for rate limiting
 * - Web Crypto API (available by default in Workers runtime)
 * - Optional environment variable RATE_LIMIT_PER_IP to configure rate limit
 * 
 * Internal modules:
 * - rateLimit.js: Rate limiting functionality
 * - imageGenerators/bmp.js: BMP image format generation
 * - imageGenerators/png.js: PNG image format generation
 * - fractal.js: Core fractal generation algorithms
 */

import { XMLParser } from 'fast-xml-parser';
import { checkRateLimit } from './rateLimit';
import { createMinimalBMP } from './imageGenerators/bmp';
import { createMinimalPNG } from './imageGenerators/png';
import { generateFractal } from './fractal';
import { createPoll, vote } from './poll';
import { withApiKeyValidation } from './middleware/validateApiKey';

addEventListener('fetch', event => {
	event.respondWith(handleRequest(event.request))
})

/**
 * Respond with a page that instructs search crawlers and AI indexers not to index.
 * @param {Request} request
 * @returns {Response}
 */
async function handleRequest(request) {
	const url = new URL(request.url)

	// Only process the root URL; otherwise, return a 404.
	if (url.pathname !== "/") {
		return new Response("Not Found", { status: 404 })
	}

	// Define an HTML page that includes a meta robots tag.
	const html = `
		<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<!-- Instruct crawlers and AI indexers not to index the page -->
				<meta name="robots" content="noindex, nofollow">
				<title>Access Restricted</title>
			</head>
			<body>
				<h1>Access Restricted</h1>
				<p>This page is designed not to be crawled or indexed by search engines or AI services.</p>
			</body>
		</html>
	`

	// Set the X-Robots-Tag header to further prevent indexing.
	const headers = {
		"Content-Type": "text/html",
		"X-Robots-Tag": "noindex, nofollow"
	}

	return new Response(html, { headers })
}

// Add the new endpoint to the router
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let response;

		//chec the binding of KV
		console.log(env.POLLS);
		console.log(env.RATE_LIMIT);

		try {
			await env.POLLS.put('test-key', 'test-value');
			const value = await env.POLLS.get('test-key');
			console.log('KV test successful:', value);
			console.log('env.POLLS binding:', env.POLLS);
		} catch (error) {
			console.error('KV test failed:', error);
		}
		
		if (url.pathname === '/') {
			response = await handleRequest(request);
		} else if (url.pathname === '/robots.txt') {
			response = new Response('User-agent: *\nDisallow: /', {
				headers: {
					'Content-Type': 'text/plain',
					'Cache-Control': 'public, max-age=86400'
				}
			});
		} else if (url.pathname === '/fractal') {
			response = await handleFractalRequest(request);
		} else if (url.pathname === '/status') {
			response = new Response('Worker is running', { status: 200 });
		} else if (url.pathname === '/ndjson-to-json') {
			response = await handleNdjsonRequest(request, env);
		} else if (url.pathname === '/xml-to-json') {
			response = await handleXmlRequest(request, env);
		} else if (url.pathname === '/poll/vote') {
			response = await handleVoteRequest(request, env);
		} else if (url.pathname === '/poll/results/json') {
			response = await handlePollResultsJson(request, env);
		} else if (url.pathname === '/poll/results/html') {
			response = await handlePollResultsHtml(request, env);

			// BELOW ARE PROTECTED ROUTES THAT REQUIRE AN API KEY
		} else if (url.pathname === '/poll/new') {
			const handler = async (request, env, ctx) => {
				return await handleCreatePollRequest(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/all') {
			const handler = async (request, env, ctx) => {
				return await handleGetAllPolls(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/protected') {
			const handler = async (request, env, ctx) => {
				return new Response('This is a protected route but you are now allowed to access it');
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else {
			response = new Response('Not Found ' + url.pathname, { status: 404 });
		}
		
		// GLOBAL: Clone the response and set the X-Robots-Tag header for all pages
		const newResponse = new Response(response.body, response);
		newResponse.headers.set('X-Robots-Tag', 'noindex, nofollow');

		// Add this after the console.log statements
		try {
			await env.POLLS.put('test-key', 'test-value');
			const value = await env.POLLS.get('test-key');
			console.log('KV test successful:', value);
		} catch (error) {
			console.error('KV test failed:', error);
		}

		return newResponse;
	}
};

async function handleFractalRequest(request) {
	const url = new URL(request.url);
	
	// Parse URL parameters
	const seedParam = url.searchParams.get('seed');
	const typeParam = url.searchParams.get('type');
	const widthParam = url.searchParams.get('width');
	const heightParam = url.searchParams.get('height');
	const bmpParam = url.searchParams.get('bmp');
	const iterParam = url.searchParams.get('iter');
	const useBmp = bmpParam !== 'false'; // defaults to true
	const seed = seedParam ? parseInt(seedParam) : Math.floor(Math.random() * 1000000);
	
	// Set size limits based on format
	const maxWidth = useBmp ? 800 : 320;
	const maxHeight = useBmp ? 600 : 200;

	// Apply size limits
	const requestedWidth = widthParam ? parseInt(widthParam) : 720;
	const requestedHeight = heightParam ? parseInt(heightParam) : 432;
	
	const width = Math.min(requestedWidth, maxWidth);
	const height = Math.min(requestedHeight, maxHeight);
	
	// Parse iterations parameter with a default of 50 and a maximum of 800
	const maxIter = Math.min(iterParam ? parseInt(iterParam) : 50, 800);
	
	// Simple random number generator with seed
	const random = (() => {
		let state = seed;
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 0xFFFFFFFF;
		};
	})();
	
	// Randomly choose fractal type if not specified
	const fractalType = typeParam || (random() < 0.5 ? 'mandelbrot' : 'julia');
	
	// Generate fractal
	const pixelData = generateFractal(width, height, maxIter, seed, fractalType);

	// Return response
	if (useBmp) {
		const bmpData = createMinimalBMP(width, height, pixelData);
		return new Response(bmpData, {
			headers: {
				'Content-Type': 'image/bmp',
				'Content-Disposition': `inline; filename="fractal-${seed}.bmp"`,
				'X-Fractal-Seed': seed.toString()
			}
		});
	} else {
		const pngData = createMinimalPNG(width, height, pixelData);
		return new Response(pngData, {
			headers: {
				'Content-Type': 'image/png',
				'Content-Disposition': `inline; filename="fractal-${seed}.png"`,
				'X-Fractal-Seed': seed.toString()
			}
		});
	}
}

// handle the ndjson-to-json request
// example: /ndjson-to-json?url=https://ntfy.sh/FdKwILjQxxHWZ26u/json?poll=1&since=1h
async function handleNdjsonRequest(request, env) {
	const VALID_HOSTS_FOR_NDJSON_TO_JSON = env.ENABLE_IMAGE_GENERATION || "ntfy.sh,stuarteggerton.com";

	// Create a URL object to access the query parameters
	const url = new URL(request.url);

	// Look for a URL parameter named "url"
	const urlParam = url.searchParams.get('url');

	// if the url parameter is not set, return a 400 error
	if (!urlParam) {
		return new Response('URL parameter is required', { status: 400 });
	}

	// check if the url is from a valid host
	const urlObj = new URL(urlParam);
	const hostname = urlObj.hostname;
	if (!VALID_HOSTS_FOR_NDJSON_TO_JSON.includes(hostname)) {
		// Use 403 Forbidden since this is a policy restriction rather than invalid input
		return new Response('Invalid hostname - limited hostnames allowed in url parameter', { status: 403 });
	}

	// Fetch the remote NDJSON content from the given URL
	let remoteResponse;
	try {
		remoteResponse = await fetch(urlParam);
	} catch (error) {
		return new Response('Error fetching URL', { status: 400 });
	}

	// Convert the fetched response to text (NDJSON content)
	const ndjsonText = await remoteResponse.text();

	// Split the NDJSON by newlines and parse each line as a JSON object
	const ndjsonLines = ndjsonText.split('\n');
	const jsonArray = [];
	
	for (const line of ndjsonLines) {
		if (line.trim()) {
			try {
				const jsonObject = JSON.parse(line);
				jsonArray.push(jsonObject);
			} catch (error) {
				return new Response('Invalid NDJSON format', { status: 400 });
			}
		}
	}
	
	return new Response(JSON.stringify(jsonArray), {
		headers: { 'Content-Type': 'application/json' }
	});
}

async function handleXmlRequest(request, env) {
	const VALID_HOSTS_FOR_XML_TO_JSON = "api.irishrail.ie,stuarteggerton.com";
	const url = new URL(request.url);
	// Get full URL from url parameter and extract everything after url=
	const urlParam = decodeURIComponent(url.searchParams.toString().split('url=')[1]);

	if (!urlParam) {
		return new Response('URL parameter is required', { status: 400 });
	}

	const urlObjXML = new URL(urlParam);
	const hostnameXML = urlObjXML.hostname;
	if (!VALID_HOSTS_FOR_XML_TO_JSON.split(',').includes(hostnameXML)) {
		return new Response('Invalid hostname - limited hostnames allowed in url parameter', { status: 403 });
	}

	try {
		const remoteResponse = await fetch(urlParam);

		//check the remoteresponse
		if (!remoteResponse.ok) {
			//log the error
			console.error('Error fetching URL', remoteResponse.statusText);
			console.error('Error fetching URL', remoteResponse.message);


			return new Response('Error fetching URL ' + urlParam, { status: 400 });
		}


		const xmlText = await remoteResponse.text();

		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			parseTagValue: true,
			isArray: (name, jpath, isLeafNode, isAttribute) => {
				// Return true if element has child nodes
				// This ensures nested elements are properly handled as arrays
				return !isLeafNode;
			}
		});

		const jsonResult = parser.parse(xmlText);
		return new Response(JSON.stringify(jsonResult), {
			headers: { 'Content-Type': 'application/json' }
		});

	} catch (error) {
		return new Response('Invalid XML format: ' + error.message, { status: 400 });
	}
}

async function handleCreatePollRequest(request, env) {
	try {
		const params = await request.json();
		const poll = await createPoll(params, env.POLLS);
		
		return new Response(JSON.stringify(poll), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleGetAllPolls(request, env) {
	try {
		const polls = await env.POLLS.list();
		const allPolls = [];  // Changed variable name to avoid conflict
		
		for (const poll of polls.keys) {
			console.log(`about to get poll ${poll.name}`);
			const pollData = await env.POLLS.get(poll.name);

			//if the pollData is null or not valid json, skip it
			if (pollData === null || pollData === undefined || pollData === '') {
				continue;
			}

			//check if the pollData is valid json
			try {
				const pollDataParsed = JSON.parse(pollData);
				allPolls.push(pollDataParsed);
			} catch (error) {
				console.error('Error parsing poll data:', error);
				continue;
			}

			//sort the pollData by closedAt date so the latest poll is first
			allPolls.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));

			//parse the pollData
			const pollDataParsed = JSON.parse(pollData);
			allPolls.push(JSON.parse(pollData));
		}

		return new Response(JSON.stringify(allPolls), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ 
			error: error.message,
			stack: error.stack 
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleVoteRequest(request, env) {
	try {
		const { pollId, optionIndex } = await request.json();
		const updatedPoll = await vote(pollId, optionIndex, env.POLLS);
		
		return new Response(JSON.stringify(updatedPoll), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handlePollResultsJson(request, env) {
	try {
		const url = new URL(request.url);
		const pollId = url.searchParams.get('id');
		if (!pollId) {
			return new Response('Poll ID is required', { status: 400 });
		}

		const pollData = await env.POLLS.get(pollId);
		if (!pollData) {
			return new Response('Poll not found', { status: 404 });
		}

		return new Response(pollData, {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handlePollResultsHtml(request, env) {
	try {
		const url = new URL(request.url);
		const pollId = url.searchParams.get('id');
		if (!pollId) {
			return new Response('Poll ID is required', { status: 400 });
		}

		const pollData = await env.POLLS.get(pollId);
		if (!pollData) {
			return new Response('Poll not found', { status: 404 });
		}

		const poll = JSON.parse(pollData);
		const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);

		const html = `
			<!DOCTYPE html>
			<html>
			<head>
				<title>Poll Results</title>
				<style>
					.poll-results { max-width: 600px; margin: 20px auto; }
					.option { margin: 10px 0; padding: 10px; background: #f5f5f5; }
					.bar { height: 20px; background: #4CAF50; margin-top: 5px; }
				</style>
			</head>
			<body>
				<div class="poll-results">
					<h1>Poll Results</h1>
					${poll.options.map(opt => `
						<div class="option">
							<strong>${opt.name}</strong>
							<div>Votes: ${opt.votes}</div>
							${totalVotes > 0 ? `
								<div class="bar" style="width: ${(opt.votes / totalVotes) * 100}%"></div>
							` : ''}
						</div>
					`).join('')}
					<div class="total">Total Votes: ${totalVotes}</div>
				</div>
			</body>
			</html>
		`;

		return new Response(html, {
			headers: { 'Content-Type': 'text/html' }
		});
	} catch (error) {
		return new Response(`<h1>Error</h1><p>${error.message}</p>`, {
			status: 500,
			headers: { 'Content-Type': 'text/html' }
		});
	}
}