// StudioSpace Backend - automated API tests
// Run with:  node test-api.mjs   (server must already be running)
import "dotenv/config";

const BASE = `http://localhost:${process.env.PORT || 8000}`;
const ORIGIN = process.env.BETTER_AUTH_URL || BASE;
const CLIENT_URL = process.env.CLIENT_URL;

let passed = 0;
let failed = 0;

function check(name, condition, extra = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// ---- tiny cookie jar (Node fetch has no built-in jar) ----
function createJar() {
  const cookies = new Map();
  return {
    store(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(";");
        const idx = pair.indexOf("=");
        cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(name) {
      return cookies.get(name);
    },
    entries() {
      return [...cookies.entries()];
    },
    clear() {
      cookies.clear();
    },
  };
}

async function api(path, { method = "GET", body, jar, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      Origin: ORIGIN,
      ...(jar && jar.header() ? { Cookie: jar.header() } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.store(res);
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, raw: text };
}

// ============================================================
console.log("\n--- Stage 1: BetterAuth authentication ---");
{
  const jar = createJar();

  // CORS preflight with credentials
  const pre = await fetch(BASE + "/api/auth/get-session", {
    method: "OPTIONS",
    headers: { Origin: CLIENT_URL, "Access-Control-Request-Method": "GET" },
  });
  check(
    "CORS preflight allows credentials",
    pre.headers.get("access-control-allow-credentials") === "true",
    `got: ${pre.headers.get("access-control-allow-credentials")}`
  );
  check(
    "CORS preflight allows frontend origin",
    pre.headers.get("access-control-allow-origin") === CLIENT_URL,
    `got: ${pre.headers.get("access-control-allow-origin")}`
  );

  // Sign up (falls back to sign-in when the user already exists,
  // so the whole suite can be re-run safely)
  const credentials = {
    name: "Alice Owner",
    email: "alice@example.com",
    photoURL: "https://example.com/alice.png",
    password: "Password1234",
  };
  let signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    jar,
    body: credentials,
  });
  if (signUp.status !== 200) {
    signUp = await api("/api/auth/sign-in/email", {
      method: "POST",
      jar,
      body: { email: credentials.email, password: credentials.password },
    });
  }
  check("sign-up (or sign-in) returns 200", signUp.status === 200, `got ${signUp.status} ${signUp.raw}`);
  const setCookie = signUp.headers.get("set-cookie") || "";
  check("session cookie is HTTPOnly", /httponly/i.test(setCookie), `got: ${setCookie}`);
  check("session cookie exists", jar.get("better-auth.session_token") !== undefined || setCookie.length > 0, `cookies: ${[...jar.entries()]}`);

  // Duplicate sign up
  const dup = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Alice Owner", email: "alice@example.com", password: "Password1234" },
  });
  check("duplicate sign-up rejected", dup.status >= 400, `got ${dup.status}`);

  // Session persists across requests (reload simulation)
  const session1 = await api("/api/auth/get-session", { jar });
  check("get-session returns logged in user", session1.status === 200 && session1.data?.user?.email === "alice@example.com", `got ${session1.status} ${session1.raw}`);
  check("session response contains no password hash", !JSON.stringify(session1.data).includes("password"), `got: ${session1.raw}`);

  // Wrong password
  const badLogin = await api("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: "alice@example.com", password: "WrongPassword1" },
  });
  check("wrong password returns 401", badLogin.status === 401, `got ${badLogin.status}`);

  // Sign in with correct password (new jar)
  const jar2 = createJar();
  const signIn = await api("/api/auth/sign-in/email", {
    method: "POST",
    jar: jar2,
    body: { email: "alice@example.com", password: "Password1234" },
  });
  check("sign-in returns 200", signIn.status === 200, `got ${signIn.status} ${signIn.raw}`);
  const session2 = await api("/api/auth/get-session", { jar: jar2 });
  check("session works after sign-in", session2.status === 200 && session2.data?.user?.email === "alice@example.com", `got ${session2.raw}`);

  // JWT endpoint (BetterAuth JWT plugin)
  const token = await api("/api/auth/token", { jar: jar2 });
  check("JWT token endpoint works", token.status === 200 && typeof token.data?.token === "string", `got ${token.status} ${token.raw}`);
  if (token.data?.token) {
    const payload = JSON.parse(Buffer.from(token.data.token.split(".")[1], "base64url").toString());
    check("JWT contains user id (sub)", typeof payload.sub === "string" && payload.sub.length > 0);
    check("JWT has issuer and expiry", Boolean(payload.iss) && Boolean(payload.exp));
  }

  // Sign out
  const signOut = await api("/api/auth/sign-out", { method: "POST", jar: jar2 });
  check("sign-out returns 200", signOut.status === 200, `got ${signOut.status}`);
  const session3 = await api("/api/auth/get-session", { jar: jar2 });
  const noUser = session3.status !== 200 || !session3.data?.user;
  check("session cleared after sign-out", noUser, `got ${session3.raw}`);

  // No cookie -> no session
  const anon = await api("/api/auth/get-session");
  check("no session without cookie", !anon.data?.user, `got ${anon.raw}`);
}

// ---- results ----
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
