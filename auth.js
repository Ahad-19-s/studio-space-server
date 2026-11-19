// Authentication for the StudioSpace API.
//
// Challenge 1: mutations are authorised from BetterAuth's **HTTPOnly session
// cookie**. The Next.js app signs users in (BetterAuth + MongoDB adapter) and
// the browser stores `better-auth.session_token` as an HttpOnly cookie. This
// module builds the *same* BetterAuth instance against the *same* database and
// secret, so `getSession` validates that cookie here on the API origin.
//
// A Bearer-JWT path (verified against the client's JWKS) is kept as a fallback
// so scripts and older clients keep working — both paths answer 401 JSON when
// they fail, never an HTML 500.
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { fromNodeHeaders } from "better-auth/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { client, getDb } from "./db.js";

const BASE_URL =
  process.env.BETTER_AUTH_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:3000";

// Comma-separated allowlist of client origins (CORS + trusted origins).
const CLIENT_ORIGINS = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Local dev runs over http:// (a Secure cookie would be dropped by the
// browser); the deployed client is https:// and lives on a *different* site
// from this API, so the cookie must be SameSite=None; Secure to be sent at all.
const IS_HTTPS = BASE_URL.startsWith("https://");
const CROSS_SITE = IS_HTTPS;

/**
 * Built on first use rather than at import time: ES module imports are hoisted
 * above `await connectToMongoDB()` in index.js, so the database handle does not
 * exist yet during module evaluation.
 */
let authInstance = null;
export function getAuth() {
  if (authInstance) return authInstance;

  authInstance = betterAuth({
    secret: process.env.BETTER_AUTH_SECRET || "studiospace-dev-secret",
    baseURL: BASE_URL,
    // Same adapter + same `users` collection the Next.js app writes to, so a
    // session created on the client is readable here.
    database: mongodbAdapter(getDb(), { client }),
    user: {
      modelName: "users",
      additionalFields: {
        photoURL: { type: "string", required: false, defaultValue: "", returned: true },
      },
    },
    session: {
      cookieCache: { enabled: true, strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
    },
    // Top-level (NOT under `advanced`) — this is what origin-check reads
    // when a cookie-bearing request arrives from the client origin.
    trustedOrigins: [BASE_URL, ...CLIENT_ORIGINS],
    advanced: {
      useSecureCookies: IS_HTTPS,
      cookies: {
        session_token: {
          attributes: {
            httpOnly: true,
            secure: IS_HTTPS,
            sameSite: CROSS_SITE ? "none" : "lax",
          },
        },
        session_data: {
          attributes: {
            httpOnly: true,
            secure: IS_HTTPS,
            sameSite: CROSS_SITE ? "none" : "lax",
          },
        },
      },
    },
  });

  return authInstance;
}

// Built once and reused — creating a RemoteJWKSet per request is wasteful.
let jwks = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${BASE_URL}/api/auth/jwks`));
  }
  return jwks;
}

/**
 * Express middleware.
 *
 * Order of attempts:
 *   1. BetterAuth HTTPOnly session cookie  (primary — Challenge 1)
 *   2. `Authorization: Bearer <jwt>`        (fallback, verified via JWKS)
 *
 * On success sets `req.user = { id, name, email }` and calls `next()`.
 * On failure responds `401 { message }` as JSON.
 */
export async function requireAuth(req, res, next) {
  try {
    // ---- 1. HTTPOnly session cookie ----
    try {
      const session = await getAuth().api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (session?.user) {
        req.user = {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        };
        req.authVia = "cookie";
        return next();
      }
    } catch {
      // Fall through to the Bearer path below.
    }

    // ---- 2. Bearer JWT fallback ----
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();
      if (token) {
        try {
          const { payload } = await jwtVerify(token, getJwks());
          if (payload?.email) {
            req.user = {
              id: payload.sub || payload.id,
              name: payload.name,
              email: payload.email,
            };
            req.authVia = "bearer";
            return next();
          }
        } catch {
          // Invalid/expired token — handled by the 401 below.
        }
      }
    }

    return res.status(401).json({ message: "Unauthorized" });
  } catch (err) {
    // Never leak a stack trace: answer JSON 401 instead of an HTML 500.
    console.error("[auth] requireAuth failed:", err.message);
    return res.status(401).json({ message: "Unauthorized" });
  }
}

/**
 * Verifies ownership of a document the caller is about to mutate.
 * Compares the authenticated email against every owner-ish field the
 * collections actually use (`email` on studios/bookings).
 */
export function isOwner(doc, user) {
  if (!doc || !user?.email) return false;
  const owner = doc.ownerEmail || doc.email || doc.userEmail;
  return String(owner).toLowerCase() === String(user.email).toLowerCase();
}
