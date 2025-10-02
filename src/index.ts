// Define the environment type for TypeScript
interface Env {
	IGDB_CLIENT_ID: string;
	IGDB_CLIENT_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Function to fetch a new app token from Twitch
		const getAppToken = async (): Promise<string> => {
			const tokenUrl = `https://id.twitch.tv/oauth2/token?client_id=${env.IGDB_CLIENT_ID}&client_secret=${env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`;
			const tokenRes = await fetch(tokenUrl, { method: 'POST' });

			if (!tokenRes.ok) {
				console.error(`Twitch token fetch failed: ${tokenRes.status} ${tokenRes.statusText}`);
				const tokenErrorBody = await tokenRes.text();
				console.error(`Error body: ${tokenErrorBody}`);
				throw new Error(`Failed to fetch IGDB token: ${tokenRes.status} - ${tokenErrorBody}`);
			}

			const tokenData = await tokenRes.json();
			const token = tokenData.access_token?.trim();

			if (!token) {
				console.error("IGDB token fetch response missing access_token or is invalid", tokenData);
				throw new Error("Invalid response format from token endpoint");
			}
			return token;
		};

		try {
			const url = new URL(request.url);

			// --- Determine the IGDB endpoint ---
			// Extract the path and remove the leading /api/ part if it exists
			let igdbEndpoint = url.pathname.replace(/^\/api\//, "");
			// Ensure the endpoint doesn't start with v4/ already, as the base URL includes it
			// The IGDB base URL is https://api.igdb.com/v4/, so the endpoint part follows
			// e.g., if the incoming path is /api/games, the endpoint should be 'games'
			// if the incoming path is /api/v4/games, the endpoint should be 'v4/games' (though usually just 'games' is expected)
			// Let's handle the common case where /api/ maps directly to the endpoint name
			// e.g., /api/games -> POST to https://api.igdb.com/v4/games
			if (!igdbEndpoint) {
				return new Response(JSON.stringify({ error: "Missing IGDB endpoint in path. Expected /api/<endpoint>." }), {
					status: 400,
					headers: { "Content-Type": "application/json" }
				});
			}
			// Remove leading slash if present after /api/ removal
			igdbEndpoint = igdbEndpoint.replace(/^\//, "");

			// --- Prepare the request body (the Apicalypse query string) ---
			// IGDB expects the query (fields, where, limit, etc.) in the POST body as plain text
			const incomingBody = await request.text(); // Read the incoming request body as text
			// No parsing needed if the client sends the query string directly in the body

			// --- Attempt to fetch from cache for GET-like semantics (though IGDB uses POST) ---
			// Caching based on the query body is complex. A simpler approach for common queries:
			// Use the full request URL (including query params for potential cache keys) and method as the cache key.
			// However, since the *query* is in the POST body, a simple URL-based cache won't work perfectly.
			// For now, let's implement a basic cache using the URL (query params might be empty, relying on body uniqueness later).
			// A more robust solution might hash the request body + URL.
			// Let's skip complex caching for now unless specifically required by the use case.
			// const cacheKey = new Request(request.url, { method: request.method, headers: request.headers });
			// const cachedResponse = await caches.default.match(cacheKey);
			// if (cachedResponse) {
			//   console.log("Cache HIT");
			//   return cachedResponse;
			// }

			// --- Get the Bearer token ---
			let token = await getAppToken();

			// --- Construct the target IGDB URL ---
			// The standard IGDB v4 endpoint format
			const igdbApiUrl = `https://api.igdb.com/v4/${igdbEndpoint}`;

			// --- Make the request to IGDB ---
			let igdbResponse = await fetch(igdbApiUrl, {
				method: 'POST', // IGDB v4 API uses POST for all queries
				headers: {
					'Client-ID': env.IGDB_CLIENT_ID?.trim(),
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'text/plain', // The body is the Apicalypse query string
					'Accept': 'application/json', // Request JSON response
				},
				body: incomingBody, // Pass the incoming query string directly
			});

			// --- Handle potential token expiration (401) ---
			if (igdbResponse.status === 401) {
				console.log("Received 401, fetching new token and retrying...");
				token = await getAppToken(); // Fetch a new token
				// Retry the request with the new token
				igdbResponse = await fetch(igdbApiUrl, {
					method: 'POST',
					headers: {
						'Client-ID': env.IGDB_CLIENT_ID?.trim(),
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'text/plain',
						'Accept': 'application/json',
					},
					body: incomingBody,
				});
			}

			// --- Check final IGDB response status ---
			if (!igdbResponse.ok) {
				// If IGDB returns an error, propagate it
				const errorBody = await igdbResponse.text();
				console.error(`IGDB API Error: ${igdbResponse.status} - ${errorBody}`);
				return new Response(errorBody, {
					status: igdbResponse.status,
					headers: { "Content-Type": "application/json" } // Assume IGDB returns JSON error
				});
			}

			// --- Read and return the IGDB response ---
			const igdbResponseBody = await igdbResponse.text(); // Read as text to handle potential non-JSON responses gracefully, though IGDB usually returns JSON
			const finalResponse = new Response(igdbResponseBody, {
				status: igdbResponse.status,
				headers: {
					"Content-Type": "application/json", // Set for the response to the client
					// Add cache headers if desired for the *client's* cache, not CF cache
					// Example: Cache successful responses for 5 minutes (300 seconds)
					"Cache-Control": "public, max-age=300",
				},
			});

			// --- Optional: Cache the successful response in Cloudflare's cache ---
			// Use the original incoming request as the cache key
			// Note: Caching POST requests with bodies can be tricky. This caches based on the URL and headers.
			// The body content is crucial for the response, so this is a simplification.
			// A more robust cache key would incorporate the request body hash.
			if (igdbResponse.status === 200) {
				ctx.waitUntil(caches.default.put(request, finalResponse.clone())); // Clone the response for caching
			}


			return finalResponse;

		} catch (err: any) {
			console.error("Unexpected error in IGDB proxy:", err);
			return new Response(JSON.stringify({ error: "Internal Server Error", details: err.message }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	},
} satisfies ExportedHandler<Env>;
