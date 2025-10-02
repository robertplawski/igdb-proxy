export default {
	async fetch(request, env, ctx): Promise<Response> {
		const TOKEN_TTL = 55 * 60 * 1000; // 55 minutes
		let appToken: string | null = null;
		let tokenTimestamp = 0;

		async function getAppToken(): Promise<string> {
			const now = Date.now();
			if (appToken && now - tokenTimestamp < TOKEN_TTL) return appToken;

			const res = await fetch(
				`https://id.twitch.tv/oauth2/token?client_id=${env.IGDB_CLIENT_ID}&client_secret=${env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
				{ method: 'POST' }
			);
			const data = await res.json();
			if (!data.access_token) {
				console.error("IGDB token fetch failed", data);
				throw new Error("Failed to fetch IGDB token");
			}

			appToken = data.access_token;
			tokenTimestamp = now;
			return appToken;
		}
		try {
			const url = new URL(request.url);
			const endpoint = url.pathname.replace(/^\/api\//, ""); // e.g., /games

			const body = request.method !== "GET" ? await request.text() : undefined;

			// Try cache first
			if (request.method === "GET") {
				const cacheKey = new Request(request.url.toString(), request);
				const cached = await caches.default.match(cacheKey);
				if (cached) return cached;
			}

			let token = await getAppToken();

			let igdbRes = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
				method: request.method,
				headers: {
					"Client-ID": env.IGDB_CLIENT_ID,
					"Authorization": `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body, // Only present for POST/PUT
			});

			// Retry once if token expired
			if (igdbRes.status === 401) {
				appToken = null;
				token = await getAppToken();
				igdbRes = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
					method: request.method,
					headers: {
						"Client-ID": env.IGDB_CLIENT_ID,
						"Authorization": `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: body,
				});
			}

			// Read text from IGDB response
			const igdbText = await igdbRes.text();

			const response = new Response(igdbText, {
				status: igdbRes.status,
				headers: { "Content-Type": "application/json" },
			});

			// Cache GET responses for 5 minutes
			if (request.method === "GET" && igdbRes.status === 200) {
				response.headers.append("Cache-Control", "public, max-age=300");
				ctx.waitUntil(caches.default.put(new Request(request.url.toString(), request), response.clone()));
			}

			return response;

		} catch (err: any) {
			return new Response(JSON.stringify({ error: err.message }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	},
} satisfies ExportedHandler<Env>;

