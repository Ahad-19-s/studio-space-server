import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { jwt } from "better-auth/plugins/jwt";
import { db } from "./db.js";

// BetterAuth configuration.
// - MongoDB Adapter stores users/sessions/accounts in MongoDB.
// - Users are stored in the required "users" collection.
// - The official BetterAuth JWT plugin provides JWT support
//   (GET /api/auth/token returns a signed JWT for a logged in user).
export const auth = betterAuth({
  // Secret used to sign session cookies and encrypt JWT keys.
  // Falls back to JWT_SECRET so one secret can be reused.
  secret: process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET,

  // Public URL of this server. Used for cookies and redirects.
  // In production set this to your real https backend URL.
  baseURL:
    process.env.BETTER_AUTH_URL ||
    `http://localhost:${process.env.PORT || 8000}`,

  // Frontend origins that are allowed to call this API with cookies.
  trustedOrigins: [process.env.CLIENT_URL].filter(Boolean),

  // MongoDB Native Driver adapter (no Mongoose).
  database: mongodbAdapter(db),

  // Email + password registration and login.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  // Store users in the "users" collection required by the assignment.
  user: {
    modelName: "users",
    // Optional profile picture field sent by the frontend on sign up.
    additionalFields: {
      photoURL: {
        type: "string",
        required: false,
        defaultValue: "",
        returned: true,
      },
    },
  },

  // BetterAuth's supported JWT integration.
  plugins: [jwt()],

  advanced: {
    // Cookies are HTTPOnly by default.
    // They become Secure automatically when baseURL uses https.
    // Set COOKIE_SAMESITE=none when the frontend and backend are on
    // different domains in production (requires https).
    ...(process.env.COOKIE_SAMESITE
      ? { defaultCookieAttributes: { sameSite: process.env.COOKIE_SAMESITE } }
      : {}),
  },
});
