const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      id: data.id,
      email: data.email,
      name: data.name,
      picture: data.picture,
    };
  } catch (error) {
    console.error("Failed to fetch Google user info:", error);
    return null;
  }
}

export async function onRequestGet(context: any): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Return client ID for frontend
  if (action === "config") {
    const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
    return new Response(
      JSON.stringify({
        clientId: GOOGLE_CLIENT_ID || null,
        redirectUri: env.GOOGLE_REDIRECT_URI || `${url.origin}/api/google-auth`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return new Response(JSON.stringify({ error: "Missing authorization code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = env.GOOGLE_REDIRECT_URI || `${url.origin}/api/google-auth`;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return new Response(JSON.stringify({ error: "Google OAuth not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token exchange failed:", errorText);
      return new Response(JSON.stringify({ error: "Failed to exchange code for token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return new Response(JSON.stringify({ error: "No access token received" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get user info from Google
    const userInfo = await getGoogleUserInfo(accessToken);

    if (!userInfo) {
      return new Response(JSON.stringify({ error: "Failed to get user info" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Store user info in database if available
    if (env.DB) {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            picture TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_login TEXT DEFAULT CURRENT_TIMESTAMP
          )`
        ).run();

        // Upsert user info
        await env.DB.prepare(
          `INSERT INTO users (user_id, email, name, picture, last_login)
           VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             email = excluded.email,
             name = excluded.name,
             picture = excluded.picture,
             last_login = excluded.last_login`
        )
          .bind(userInfo.id, userInfo.email, userInfo.name, userInfo.picture || null)
          .run();
      } catch (dbError) {
        console.error("Database error:", dbError);
        // Continue even if DB fails
      }
    }

    // Create session token (simple implementation)
    const sessionToken = btoa(JSON.stringify({
      userId: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      exp: Date.now() + MAX_AGE_SECONDS * 1000,
    }));

    const cookieSegments = [
      `google_auth=${sessionToken}`,
      `Max-Age=${MAX_AGE_SECONDS}`,
      "Path=/",
      "SameSite=Lax",
      "HttpOnly",
    ];
    if (url.protocol === "https:") {
      cookieSegments.push("Secure");
    }

    // Redirect back to home page
    const redirectUrl = state || "/";
    return Response.redirect(redirectUrl, 302, {
      headers: {
        "Set-Cookie": cookieSegments.join("; "),
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function onRequestPost(context: any): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "logout") {
    const cookieSegments = [
      `google_auth=`,
      `Max-Age=0`,
      "Path=/",
      "SameSite=Lax",
    ];
    if (url.protocol === "https:") {
      cookieSegments.push("Secure");
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookieSegments.join("; "),
      },
    });
  }

  // Get current user info
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) return;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = value;
  });

  const sessionToken = cookies.google_auth;
  if (!sessionToken) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const sessionData = JSON.parse(atob(sessionToken));
    if (sessionData.exp && sessionData.exp < Date.now()) {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        authenticated: true,
        user: {
          id: sessionData.userId,
          email: sessionData.email,
          name: sessionData.name,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

