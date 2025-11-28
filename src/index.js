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
import { createPoll, vote, getPoll, listPolls, resetPoll, deletePoll } from './poll';
import { withApiKeyValidation } from './middleware/validateApiKey';

function getClientFingerprint(request) {
	const ip =
		request.headers.get('cf-connecting-ip') ||
		(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
		'unknown';
	const ua = request.headers.get('user-agent') || 'unknown';
	const lang = request.headers.get('accept-language') || '';
	return `${ip}|${ua}|${lang}`;
}

async function createVoterHash(pollId, request, env) {
	const fingerprint = getClientFingerprint(request);
	const secret = env.MASTER_KEY || 'local-secret';
	const encoder = new TextEncoder();
	const data = encoder.encode(`${secret}:${pollId}:${fingerprint}`);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

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
		} else if (url.pathname === '/poll/app') {
			const html = renderPollSpa(url);
			response = new Response(html, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'no-store'
				}
			});

			// BELOW ARE PROTECTED ROUTES THAT REQUIRE AN API KEY
		} else if (url.pathname === '/poll/new') {
			const handler = async (request, env, ctx) => {
				return await handleCreatePollRequest(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/reset') {
			const handler = async (request, env, ctx) => {
				return await handleResetPollRequest(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/admin') {
			const handler = async (request, env, ctx) => {
				return await handleAdminListPolls(env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/admin/delete') {
			const handler = async (request, env, ctx) => {
				return await handleAdminDeletePoll(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/admin/save') {
			const handler = async (request, env, ctx) => {
				return await handleAdminSavePoll(request, env);
			};
			response = await withApiKeyValidation(handler)(request, env, ctx);
		} else if (url.pathname === '/poll/admin/spa') {
			const html = renderAdminPollSpa(url);
			const handler = async () => new Response(html, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'no-store'
				}
			});
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
		const poll = await createPoll(params, env.DB);
		
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
		const polls = await listPolls(env.DB);

		return new Response(JSON.stringify(polls), {
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
		if (!pollId || optionIndex === undefined || optionIndex === null) {
			return new Response(JSON.stringify({ error: 'pollId and optionIndex are required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const voterHash = await createVoterHash(pollId, request, env);
		const updatedPoll = await vote(pollId, optionIndex, env.DB, voterHash);
		
		return new Response(JSON.stringify(updatedPoll), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		let status = 400;
		if (error.message.includes('already voted')) {
			status = 409;
		} else if (error.message.includes('Poll not found')) {
			status = 404;
		}

		return new Response(JSON.stringify({ error: error.message }), {
			status,
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

		const poll = await getPoll(pollId, env.DB);

		return new Response(JSON.stringify(poll), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleResetPollRequest(request, env) {
	try {
		const { pollId } = await request.json();
		if (!pollId) {
			return new Response(JSON.stringify({ error: 'pollId is required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const poll = await resetPoll(pollId, env.DB);

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

async function handleAdminListPolls(env) {
	const results = await listPolls(env.DB);
	return new Response(JSON.stringify(results), {
		headers: { 'Content-Type': 'application/json' }
	});
}

async function handleAdminDeletePoll(request, env) {
	try {
		const { pollId } = await request.json();
		if (!pollId) {
			return new Response(JSON.stringify({ error: 'pollId is required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		await deletePoll(pollId, env.DB);

		return new Response(JSON.stringify({ ok: true, deleted: pollId }), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error.message }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleAdminSavePoll(request, env) {
	try {
		const body = await request.json();
		const { id, question, options, durationSeconds, open, close } = body || {};
		if (!options || !Array.isArray(options) || options.length === 0) {
			return new Response(JSON.stringify({ error: 'options are required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const sanitizedOptions = options.map(opt => ({
			name: (opt.name || '').trim(),
			url: (opt.url || '').trim(),
			votes: 0
		})).filter(opt => opt.name);

		if (sanitizedOptions.length === 0) {
			return new Response(JSON.stringify({ error: 'options must include at least one name' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const now = Date.now();
		const durationMs = (Number(durationSeconds) || 30) * 1000;
		let openDate = open ? new Date(open) : new Date(now);
		let closeDate = close ? new Date(close) : new Date(now + durationMs);

		if (id) {
			await deletePoll(id, env.DB);
		}

		const params = {
			id,
			question,
			open: openDate.toISOString(),
			close: closeDate.toISOString(),
			durationSeconds: Number(durationSeconds) || 30,
			options: sanitizedOptions
		};
		const poll = await createPoll(params, env.DB);

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

async function handlePollResultsHtml(request, env) {
	try {
		const url = new URL(request.url);
		const pollId = url.searchParams.get('id');
		if (!pollId) {
			return new Response('Poll ID is required', { status: 400 });
		}

		const poll = await getPoll(pollId, env.DB);
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
					<h1>${poll.question || 'Poll Results'}</h1>
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

function renderPollSpa(url) {
	const pollId = url.searchParams.get('id') || '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Poll Vote</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #0b1021;
      --panel: #121a36;
      --accent: #7be0ad;
      --accent-2: #6ca0ff;
      --text: #e9eef9;
      --muted: #9aa6c2;
      --danger: #ff8c7b;
      --border: #1f2c52;
      --pill: rgba(255,255,255,0.06);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 20% 20%, #101a33, #0b1021 40%), radial-gradient(circle at 80% 0%, #14254a, #0b1021 40%), #0b1021;
      color: var(--text);
      min-height: 100vh;
    }
    .shell { max-width: 820px; margin: 0 auto; padding: 32px 20px 48px; position: relative; overflow:hidden; }
    header { margin-bottom: 12px; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.5px; }
    p.lead { margin: 0; color: var(--muted); }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    .countdown-pill { font-size: 18px; font-weight: 800; background: linear-gradient(120deg, #ff8c7b, #6ca0ff); color: #0b1021; }
    button {
      border: none;
      border-radius: 12px;
      padding: 12px 18px;
      font-weight: 700;
      cursor: pointer;
      color: #0b1021;
      background: linear-gradient(120deg, var(--accent), var(--accent-2));
      box-shadow: 0 10px 25px rgba(107, 195, 179, 0.35);
      transition: transform 0.1s ease, box-shadow 0.2s ease;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(107,195,179,0.45); }
    button:active { transform: translateY(0); box-shadow: 0 6px 16px rgba(107,195,179,0.35); }
    .meta-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .pill { padding: 8px 12px; border-radius: 999px; background: var(--pill); border: 1px solid var(--border); color: var(--muted); font-size: 13px; }
    .pill strong { color: var(--text); }
    .options { display: grid; gap: 10px; margin: 12px 0 4px; }
    .option {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: #0f1731;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: center;
    }
    .option .meta { display: grid; gap: 4px; }
    .option .name { font-weight: 700; font-size: 16px; }
    .votes { color: var(--muted); font-size: 13px; }
    .bar { width: 100%; height: 8px; border-radius: 999px; background: #121c3c; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(120deg, var(--accent), var(--accent-2)); }
    .status { margin: 6px 0 0; color: var(--muted); font-size: 14px; min-height: 18px; }
    .status.error { color: var(--danger); }
    .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
    .badge { padding: 6px 10px; border-radius: 8px; background: #132043; color: var(--text); font-weight: 700; }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1 id="title-question">Poll Vote</h1>
      <p class="lead" id="title-sub">Load a poll and vote before time runs out.</p>
    </header>

    <div class="card">
      <div class="meta-row">
        <div class="pill countdown-pill" id="countdown-pill">Countdown: --</div>
        <div class="pill" id="total-pill">Total votes: --</div>
      </div>
      <div id="status" class="status"></div>
      <div id="options" class="options"></div>
      <div class="actions">
        <button id="vote-btn">Submit vote</button>
      </div>
    </div>
  </div>

  <script>
    (() => {
      const DRUMROLL_MS = 3000;
      const state = {
        pollId: "${pollId}",
        poll: null,
        selected: null,
        phase: 'idle', // idle | countdown | drumroll | reveal
        endsAt: null,
        timers: { refresh: null, countdown: null, drumroll: null },
        confettiShown: false
      };

      const els = {
        voteBtn: document.getElementById('vote-btn'),
        options: document.getElementById('options'),
        status: document.getElementById('status'),
        countdown: document.getElementById('countdown-pill'),
        total: document.getElementById('total-pill'),
        title: document.getElementById('title-question'),
        subtitle: document.getElementById('title-sub')
      };

      function setStatus(msg, isError = false) {
        els.status.textContent = msg || '';
        els.status.className = 'status' + (isError ? ' error' : '');
      }

      function clearTimers() {
        Object.values(state.timers).forEach(t => t && clearInterval(t));
        state.timers = { refresh: null, countdown: null, drumroll: null };
      }

      function fmtTime(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const m = String(Math.floor(total / 60)).padStart(2,'0');
        const s = String(total % 60).padStart(2,'0');
        return m + ':' + s;
      }

      function viewOptions() {
        if (!state.poll) return [];
        const opts = [...state.poll.options];
        if (state.phase === 'reveal') {
          return opts.sort((a,b) => (b.votes || 0) - (a.votes || 0));
        }
        return opts;
      }

      function renderPoll() {
        const poll = state.poll;
        if (!poll) {
          els.options.innerHTML = '<div class="status">No poll loaded.</div>';
          els.title.textContent = 'Poll Vote';
          els.subtitle.textContent = state.pollId ? 'Loading poll...' : 'Add ?id=<poll-id> to the URL.';
          els.countdown.textContent = 'Countdown: --';
          els.total.textContent = 'Total votes: --';
          return;
        }

        els.title.textContent = poll.question || 'Poll Vote';
        els.subtitle.textContent = state.phase === 'reveal'
          ? 'Results locked in.'
          : state.phase === 'drumroll'
            ? 'Drum roll...'
            : 'Vote before the timer hits zero.';

        const total = poll.options.reduce((sum, opt) => sum + (opt.votes || 0), 0);
        const remainingMs = state.phase === 'countdown' && state.endsAt
          ? Math.max(0, state.endsAt - Date.now())
          : 0;

        els.countdown.textContent = state.phase === 'drumroll'
          ? 'Countdown: 00:00 (drum roll...)'
          : state.phase === 'reveal'
            ? 'Countdown: finished'
            : 'Countdown: ' + fmtTime(remainingMs);

        const showNumbers = state.phase === 'reveal';
        els.total.textContent = 'Total votes: ' + total;

        const opts = viewOptions();
        els.options.innerHTML = opts.map((opt, idx) => {
          const checked = state.selected === idx ? 'checked' : '';
          const pct = total > 0 ? Math.round(((opt.votes || 0) / total) * 100) : 0;
          const votesLabel = showNumbers ? (opt.votes || 0) + ' vote(s) · ' + pct + '%' : 'Votes hidden until reveal';
          const disabled = state.phase !== 'countdown' ? 'disabled' : '';
          const orderBadge = state.phase === 'reveal' ? '<span class="badge">#' + (idx + 1) + '</span>' : '';
          return [
            '<label class="option">',
              '<input type="radio" name="option" value="', idx, '" ', checked, ' ', disabled, ' style="margin-right:10px;">',
              '<div class="meta">',
                '<div class="name">', opt.name, '</div>',
                '<div class="bar"><span style="width:', showNumbers ? pct : 0, '%;"></span></div>',
                '<div class="votes">', votesLabel, '</div>',
              '</div>',
              orderBadge,
            '</label>'
          ].join('');
        }).join('');

        els.options.querySelectorAll('input[name="option"]').forEach(input => {
          input.addEventListener('change', () => {
            state.selected = Number(input.value);
          });
        });

        if (state.phase === 'drumroll') {
          setStatus('Drum roll....', false);
        } else if (state.phase === 'reveal') {
          setStatus('Results revealed.', false);
          if (!state.confettiShown) {
            state.confettiShown = true;
            triggerConfetti();
          }
        }
      }

      async function fetchPollOnce(showError = true) {
        if (!state.pollId) return;
        try {
          const res = await fetch('/poll/results/json?id=' + encodeURIComponent(state.pollId));
          if (!res.ok) throw new Error((await res.text()) || 'Failed to load poll');
          state.poll = await res.json();
          renderPoll();
        } catch (err) {
          if (showError) setStatus(err.message, true);
        }
      }

      async function submitVote() {
        if (state.phase !== 'countdown') {
          setStatus('Voting closed.', true);
          return;
        }
        if (!state.poll) {
          setStatus('Load a poll first.', true);
          return;
        }
        if (state.selected === null) {
          setStatus('Select an option to vote.', true);
          return;
        }
        setStatus('Submitting vote...');
        try {
          const res = await fetch('/poll/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pollId: state.poll.id, optionIndex: state.selected })
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Vote failed');
          }
          state.poll = data;
          setStatus('Vote recorded. Results updating live.');
          renderPoll();
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      function startCountdown() {
        if (!state.poll) return;
        clearTimers();
        const durationMs = (Number(state.poll.durationSeconds) || 30) * 1000;
        const openMs = Date.parse(state.poll.open || '');
        const closeMs = Date.parse(state.poll.close || '');

        let target = Date.now() + durationMs;
        if (Number.isFinite(openMs)) {
          target = openMs + durationMs;
        }
        if (Number.isFinite(closeMs)) {
          target = Math.min(target, closeMs);
        }
        state.endsAt = target;

        if (state.endsAt <= Date.now()) {
          state.phase = 'drumroll';
          renderPoll();
          state.timers.drumroll = setTimeout(() => revealResults(), DRUMROLL_MS);
          return;
        }

        state.phase = 'countdown';
        renderPoll();

        state.timers.refresh = setInterval(() => fetchPollOnce(false), 1000);
        state.timers.countdown = setInterval(() => {
          const remaining = state.endsAt - Date.now();
          if (remaining <= 0) {
            clearTimers();
            state.phase = 'drumroll';
            renderPoll();
            state.timers.drumroll = setTimeout(() => revealResults(), DRUMROLL_MS);
          } else {
            renderPoll();
          }
        }, 1000);
      }

      async function revealResults() {
        state.phase = 'reveal';
        await fetchPollOnce(false);
        renderPoll();
      }

      els.voteBtn.addEventListener('click', submitVote);

      function triggerConfetti() {
        const container = document.querySelector('.shell');
        for (let i = 0; i < 80; i++) {
          const conf = document.createElement('div');
          conf.textContent = '🎉';
          conf.style.position = 'absolute';
          conf.style.left = Math.random() * 100 + '%';
          conf.style.top = '-10px';
          conf.style.fontSize = '16px';
          conf.style.transition = 'transform 1.2s ease-out, opacity 1.2s ease-out';
          container.appendChild(conf);
          requestAnimationFrame(() => {
            const drop = 400 + Math.random() * 200;
            const rot = Math.random() * 360;
            conf.style.transform = 'translateY(' + drop + 'px) rotate(' + rot + 'deg)';
            conf.style.opacity = '0';
          });
          setTimeout(() => conf.remove(), 1300);
        }
      }

      if (state.pollId) {
        setStatus('Loading poll...');
        fetchPollOnce(true).then(() => { if (state.poll) startCountdown(); });
      } else {
        setStatus('No poll id in URL. Add ?id=<poll-id>.', true);
        renderPoll();
      }
    })();
  </script>
</body>
</html>`;
}

function renderAdminPollSpa(url) {
	const keyParam = url.searchParams.get('key') || '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Poll Admin</title>
  <style>
    body { font-family: "Inter", system-ui, -apple-system, sans-serif; background: #0b1021; color: #e9eef9; margin:0; padding:24px; }
    h1 { margin: 0 0 12px; }
    .card { background: #121a36; border: 1px solid #1f2c52; border-radius: 12px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #1f2c52; text-align: left; }
    th { color: #9aa6c2; font-weight: 700; }
    button { border: none; border-radius: 8px; padding: 8px 12px; font-weight: 700; cursor: pointer; margin-right: 6px; }
    .btn { background: linear-gradient(120deg, #7be0ad, #6ca0ff); color: #0b1021; }
    .btn-danger { background: #ff8c7b; color: #0b1021; }
    .pill { display:inline-block; padding:4px 8px; border-radius:999px; background:#101a33; border:1px solid #1f2c52; color:#9aa6c2; font-size:12px; }
    .status { margin: 8px 0 12px; color: #9aa6c2; }
    a { color: #7be0ad; }
    input[type="text"] { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #1f2c52; background:#0e162d; color:#e9eef9; }
  </style>
</head>
<body>
  <h1>Poll Admin</h1>
  <div class="card">
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
      <label style="color:#9aa6c2; font-weight:600;">API Key</label>
      <input id="api-key" type="text" value="${keyParam}" placeholder="X-API-Key" />
      <button class="btn" id="load-btn">Load polls</button>
    </div>
    <div class="status" id="status">Enter your API key and load polls.</div>
    <div style="display:grid; gap:8px; margin-bottom:12px;">
      <input id="poll-id" type="text" placeholder="Poll ID (leave blank to create new)" />
      <input id="poll-question" type="text" placeholder="Question" />
      <input id="poll-duration" type="number" min="1" value="30" placeholder="durationSeconds (default 30)" />
      <textarea id="poll-options" rows="4" placeholder="One option per line (format: name|url optional)" style="resize:vertical; padding:10px; border-radius:8px; border:1px solid #1f2c52; background:#0e162d; color:#e9eef9;"></textarea>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn" id="new-btn">New Poll</button>
        <button class="btn" id="save-btn">Save Poll</button>
      </div>
    </div>
    <table id="poll-table">
      <thead>
        <tr><th>Question</th><th>Votes</th><th>Closes</th><th>Actions</th></tr>
      </thead>
      <tbody id="poll-rows">
        <tr><td colspan="4">No data</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    (() => {
      const els = {
        key: document.getElementById('api-key'),
        load: document.getElementById('load-btn'),
        status: document.getElementById('status'),
        rows: document.getElementById('poll-rows'),
        id: document.getElementById('poll-id'),
        question: document.getElementById('poll-question'),
        duration: document.getElementById('poll-duration'),
        options: document.getElementById('poll-options'),
        save: document.getElementById('save-btn'),
        fresh: document.getElementById('new-btn')
      };

      function setStatus(msg, error=false) {
        els.status.textContent = msg;
        els.status.style.color = error ? '#ff8c7b' : '#9aa6c2';
      }

      function parseOptions() {
        return els.options.value
          .split('\\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
            const [name, url=''] = line.split('|').map(s => s.trim());
            return { name, url };
          });
      }

      function fillForm(poll) {
        els.id.value = poll.id || '';
        els.question.value = poll.question || '';
        els.duration.value = poll.durationSeconds || 30;
        els.options.value = (poll.options || []).map(opt => opt.url ? (opt.name + '|' + opt.url) : opt.name).join('\\n');
      }

      async function savePoll() {
        const apiKey = els.key.value.trim();
        if (!apiKey) {
          setStatus('API key required.', true);
          return;
        }
        const payload = {
          id: els.id.value.trim() || undefined,
          question: els.question.value.trim(),
          durationSeconds: Number(els.duration.value) || 30,
          options: parseOptions()
        };
        setStatus('Saving poll...');
        try {
          const res = await fetch('/poll/admin/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Save failed');
          fillForm(data);
          await loadPolls();
          setStatus('Saved.');
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      function clearForm() {
        els.id.value = '';
        els.question.value = '';
        els.duration.value = 30;
        els.options.value = '';
      }

      function renderRows(polls, apiKey) {
        if (!polls.length) {
          els.rows.innerHTML = '<tr><td colspan="4">No polls found.</td></tr>';
          return;
        }
        els.rows.innerHTML = polls.map(p => {
          const total = p.totalVotes || 0;
          const appUrl = '/poll/app?id=' + encodeURIComponent(p.id);
          return [
            '<tr>',
            '<td><div style="font-weight:700;">', p.question || 'Untitled', '</div><div class="pill">', p.id, '</div></td>',
            '<td>', total, '</td>',
            '<td>', p.close || 'n/a', '</td>',
            '<td>',
              '<a class="pill" href="', appUrl, '" target="_blank">Open</a> ',
              '<button class="btn" data-action="edit" data-id="', p.id, '">Edit</button>',
              '<button class="btn" data-action="reset" data-id="', p.id, '">Reset</button>',
              '<button class="btn-danger" data-action="delete" data-id="', p.id, '">Delete</button>',
            '</td>',
            '</tr>'
          ].join('');
        }).join('');

        els.rows.querySelectorAll('button[data-action]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.getAttribute('data-action');
            const pollId = btn.getAttribute('data-id');
            try {
              if (action === 'edit') {
                const poll = polls.find(p => p.id === pollId);
                if (poll) fillForm(poll);
                setStatus('Loaded poll into form.');
                return;
              } else if (action === 'reset') {
                await fetch('/poll/reset', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                  body: JSON.stringify({ pollId })
                });
              } else if (action === 'delete') {
                await fetch('/poll/admin/delete', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                  body: JSON.stringify({ pollId })
                });
              }
              await loadPolls();
            } catch (err) {
              setStatus(err.message, true);
            }
          });
        });
      }

      async function loadPolls() {
        const apiKey = els.key.value.trim();
        if (!apiKey) {
          setStatus('API key required.', true);
          return;
        }
        setStatus('Loading polls...');
        try {
          const res = await fetch('/poll/admin', {
            headers: { 'X-API-Key': apiKey }
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to load polls');
          renderRows(data, apiKey);
          setStatus('Loaded ' + data.length + ' poll(s).');
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      els.load.addEventListener('click', loadPolls);
      els.key.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPolls(); });
      els.save.addEventListener('click', savePoll);
      els.fresh.addEventListener('click', clearForm);

      if (els.key.value) loadPolls();
    })();
  </script>
</body>
</html>`;
}
