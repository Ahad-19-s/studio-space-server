// StudioSpace Backend - automated API tests
// Run with:  node test-api.mjs   (server must already be running)
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

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

// Session cookie jars shared by the later stages.
const jar = createJar(); // Alice
const bobJar = createJar(); // Bob
let bookingStudioId = null; // studio used by the booking tests

// ============================================================
console.log("\n--- Stage 1: BetterAuth authentication ---");
{
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

// ============================================================
console.log("\n--- Stage 2: studio APIs secured with authentication ---");
{
  const aliceEmail = "alice@example.com";
  const bobEmail = "bob@example.com";

  // --- authentication is required ---
  const unauthAdd = await api("/add-studio", {
    method: "POST",
    body: { title: "X", category: "Music", hourlyRate: 10, location: "Y" },
  });
  check("POST /add-studio without session -> 401", unauthAdd.status === 401, `got ${unauthAdd.status}`);

  const unauthList = await api(`/my-listings/${aliceEmail}`);
  check("GET /my-listings without session -> 401", unauthList.status === 401, `got ${unauthList.status}`);

  const unauthPatch = await api("/studio/000000000000000000000000", { method: "PATCH", body: { title: "X" } });
  check("PATCH /studio without session -> 401", unauthPatch.status === 401, `got ${unauthPatch.status}`);

  const unauthDelete = await api("/studio/000000000000000000000000", { method: "DELETE" });
  check("DELETE /studio without session -> 401", unauthDelete.status === 401, `got ${unauthDelete.status}`);

  // --- second user (Bob) ---
  let bobAuth = await api("/api/auth/sign-up/email", {
    method: "POST",
    jar: bobJar,
    body: { name: "Bob Renter", email: bobEmail, password: "Password1234" },
  });
  if (bobAuth.status !== 200) {
    bobAuth = await api("/api/auth/sign-in/email", {
      method: "POST",
      jar: bobJar,
      body: { email: bobEmail, password: "Password1234" },
    });
  }
  check("second user (Bob) signed in", bobAuth.status === 200, `got ${bobAuth.status} ${bobAuth.raw}`);

  // --- Alice creates a studio ---
  const addRes = await api("/add-studio", {
    method: "POST",
    jar,
    body: {
      title: "Melody Practice Room",
      category: "Music Studio",
      hourlyRate: 25,
      securityDeposit: 100,
      maxCapacity: 8,
      location: "Dhaka, Bangladesh",
      image: "https://example.com/studio.png",
      amenities: ["Wi-Fi", "Parking"],
      overview: "A quiet practice room.",
      ownerEmail: "attacker@example.com", // must be ignored
      ownerName: "Hacker", // must be ignored
      rating: 5, // must be ignored
    },
  });
  check("POST /add-studio with session -> 201", addRes.status === 201, `got ${addRes.status} ${addRes.raw}`);
  const studioId = addRes.data?.insertedId;
  check("insertedId returned", Boolean(studioId));

  const created = await api(`/studio/${studioId}`);
  check("owner email comes from the session", created.data?.ownerEmail === aliceEmail, `got ${created.data?.ownerEmail}`);
  check("owner name comes from the session", created.data?.ownerName === "Alice Owner", `got ${created.data?.ownerName}`);
  check("client cannot set the rating", created.data?.rating === 0, `got ${created.data?.rating}`);

  // --- my listings ---
  const myList = await api(`/my-listings/${aliceEmail}`, { jar });
  check("owner can read own listings", myList.status === 200 && Array.isArray(myList.data) && myList.data.some((s) => String(s._id) === String(studioId)), `got ${myList.status}`);

  const otherList = await api(`/my-listings/${bobEmail}`, { jar });
  check("reading another user's listings -> 403", otherList.status === 403, `got ${otherList.status}`);

  // --- input validation ---
  const badRate = await api("/add-studio", { method: "POST", jar, body: { title: "T", category: "C", hourlyRate: -5, location: "L" } });
  check("negative hourly rate -> 400", badRate.status === 400, `got ${badRate.status}`);

  const missingFields = await api("/add-studio", { method: "POST", jar, body: { title: "Only title" } });
  check("missing required fields -> 400", missingFields.status === 400, `got ${missingFields.status}`);

  const badIdPatch = await api("/studio/not-an-id", { method: "PATCH", jar, body: { title: "New" } });
  check("PATCH invalid studio id -> 400", badIdPatch.status === 400, `got ${badIdPatch.status}`);

  const notFoundPatch = await api("/studio/000000000000000000000000", { method: "PATCH", jar, body: { title: "New" } });
  check("PATCH unknown studio -> 404", notFoundPatch.status === 404, `got ${notFoundPatch.status}`);

  // --- Bob creates his own studio ---
  const bobStudio = await api("/add-studio", {
    method: "POST",
    jar: bobJar,
    body: { title: "Bob Photo Loft", category: "Photo Studio", hourlyRate: 40, location: "Chattogram" },
  });
  check("Bob can create his own studio", bobStudio.status === 201, `got ${bobStudio.status} ${bobStudio.raw}`);
  const bobStudioId = bobStudio.data?.insertedId;

  // --- ownership rules ---
  const crossUpdate = await api(`/studio/${bobStudioId}`, { method: "PATCH", jar, body: { title: "Hacked" } });
  check("updating someone else's studio -> 403", crossUpdate.status === 403, `got ${crossUpdate.status}`);

  const crossDelete = await api(`/studio/${bobStudioId}`, { method: "DELETE", jar });
  check("deleting someone else's studio -> 403", crossDelete.status === 403, `got ${crossDelete.status}`);

  const ownerHijack = await api(`/studio/${studioId}`, { method: "PATCH", jar: bobJar, body: { ownerEmail: bobEmail } });
  check("cannot hijack studio ownership -> 403", ownerHijack.status === 403, `got ${ownerHijack.status}`);

  const stillBob = await api(`/studio/${bobStudioId}`);
  check("Bob's studio is unchanged", stillBob.data?.title === "Bob Photo Loft", `got ${stillBob.data?.title}`);

  // --- owner updates own studio ---
  const ownUpdate = await api(`/studio/${studioId}`, { method: "PATCH", jar, body: { title: "Melody Room (Renovated)", hourlyRate: 30 } });
  check("owner can update own studio", ownUpdate.status === 200, `got ${ownUpdate.status} ${ownUpdate.raw}`);

  const afterUpdate = await api(`/studio/${studioId}`);
  check("update was applied", afterUpdate.data?.title === "Melody Room (Renovated)" && afterUpdate.data?.hourlyRate === 30, `got ${JSON.stringify({ title: afterUpdate.data?.title, hourlyRate: afterUpdate.data?.hourlyRate })}`);

  const badUpdate = await api(`/studio/${studioId}`, { method: "PATCH", jar, body: { hourlyRate: "abc" } });
  check("invalid hourly rate update -> 400", badUpdate.status === 400, `got ${badUpdate.status}`);

  const emptyUpdate = await api(`/studio/${studioId}`, { method: "PATCH", jar, body: {} });
  check("empty update -> 400", emptyUpdate.status === 400, `got ${emptyUpdate.status}`);

  // --- delete ---
  const ownDelete = await api(`/studio/${studioId}`, { method: "DELETE", jar });
  check("owner can delete own studio", ownDelete.status === 200, `got ${ownDelete.status} ${ownDelete.raw}`);

  const gone = await api(`/studio/${studioId}`);
  check("deleted studio -> 404", gone.status === 404, `got ${gone.status}`);

  const bobDelete = await api(`/studio/${bobStudioId}`, { method: "DELETE", jar: bobJar });
  check("Bob deletes his own studio", bobDelete.status === 200, `got ${bobDelete.status}`);
}

// ============================================================
console.log("\n--- Stage 3: booking APIs ---");
{
  const aliceEmail = "alice@example.com";
  const bobEmail = "bob@example.com";

  // --- authentication required ---
  const unauthBook = await api("/bookings", {
    method: "POST",
    body: { studioId: "000000000000000000000000", bookingDate: "2027-01-01", startTime: "10:00", endTime: "12:00" },
  });
  check("POST /bookings without session -> 401", unauthBook.status === 401, `got ${unauthBook.status}`);

  const unauthMyBookings = await api(`/my-bookings/${aliceEmail}`);
  check("GET /my-bookings without session -> 401", unauthMyBookings.status === 401, `got ${unauthMyBookings.status}`);

  const unauthCancel = await api("/bookings/000000000000000000000000/cancel", { method: "PATCH" });
  check("PATCH /bookings/:id/cancel without session -> 401", unauthCancel.status === 401, `got ${unauthCancel.status}`);

  // --- a studio to book (stages 2 deleted its studios) ---
  const studioRes = await api("/add-studio", {
    method: "POST",
    jar,
    body: { title: "Sunset Recording Booth", category: "Music Studio", hourlyRate: 20, location: "Sylhet", maxCapacity: 4 },
  });
  check("studio created for booking tests", studioRes.status === 201, `got ${studioRes.status} ${studioRes.raw}`);
  bookingStudioId = studioRes.data?.insertedId;

  // --- create a booking ---
  const bookingRes = await api("/bookings", {
    method: "POST",
    jar,
    body: {
      studioId: bookingStudioId,
      bookingDate: "2027-03-10",
      startTime: "10:00",
      endTime: "12:30",
      // these must all be ignored:
      userEmail: "attacker@example.com",
      userName: "Hacker",
      totalPrice: 1,
      status: "Confirmed",
    },
  });
  check("POST /bookings with session -> 201", bookingRes.status === 201, `got ${bookingRes.status} ${bookingRes.raw}`);
  const bookingId = bookingRes.data?.insertedId;

  const booking = bookingRes.data?.booking;
  check("new booking status is Pending", booking?.status === "Pending", `got ${booking?.status}`);
  check("booking user comes from the session", booking?.userEmail === aliceEmail, `got ${booking?.userEmail}`);
  check("booking user name comes from the session", booking?.userName === "Alice Owner", `got ${booking?.userName}`);
  check("total price calculated on server (20 * 2.5 = 50)", booking?.totalPrice === 50, `got ${booking?.totalPrice}`);

  // --- read own bookings ---
  const myBookings = await api(`/my-bookings/${aliceEmail}`, { jar });
  check("owner can read own bookings", myBookings.status === 200 && Array.isArray(myBookings.data) && myBookings.data.some((b) => String(b._id) === String(bookingId)), `got ${myBookings.status}`);

  const otherBookings = await api(`/my-bookings/${bobEmail}`, { jar });
  check("reading another user's bookings -> 403", otherBookings.status === 403, `got ${otherBookings.status}`);

  // --- input validation ---
  const missing = await api("/bookings", { method: "POST", jar, body: { studioId: bookingStudioId } });
  check("missing booking fields -> 400", missing.status === 400, `got ${missing.status}`);

  const badStudio = await api("/bookings", { method: "POST", jar, body: { studioId: "not-an-id", bookingDate: "2027-03-10", startTime: "10:00", endTime: "12:00" } });
  check("invalid studio id -> 400", badStudio.status === 400, `got ${badStudio.status}`);

  const unknownStudio = await api("/bookings", { method: "POST", jar, body: { studioId: "000000000000000000000000", bookingDate: "2027-03-10", startTime: "10:00", endTime: "12:00" } });
  check("unknown studio -> 404", unknownStudio.status === 404, `got ${unknownStudio.status}`);

  const badDate = await api("/bookings", { method: "POST", jar, body: { studioId: bookingStudioId, bookingDate: "10-03-2027", startTime: "10:00", endTime: "12:00" } });
  check("invalid booking date -> 400", badDate.status === 400, `got ${badDate.status}`);

  const badTime = await api("/bookings", { method: "POST", jar, body: { studioId: bookingStudioId, bookingDate: "2027-03-10", startTime: "10am", endTime: "12:00" } });
  check("invalid start time -> 400", badTime.status === 400, `got ${badTime.status}`);

  const badRange = await api("/bookings", { method: "POST", jar, body: { studioId: bookingStudioId, bookingDate: "2027-03-10", startTime: "12:00", endTime: "10:00" } });
  check("end time before start time -> 400", badRange.status === 400, `got ${badRange.status}`);

  // --- cancel rules ---
  const bobBooking = await api("/bookings", {
    method: "POST",
    jar: bobJar,
    body: { studioId: bookingStudioId, bookingDate: "2027-03-11", startTime: "09:00", endTime: "11:00" },
  });
  check("Bob can create a booking", bobBooking.status === 201, `got ${bobBooking.status} ${bobBooking.raw}`);
  const bobBookingId = bobBooking.data?.insertedId;

  const crossCancel = await api(`/bookings/${bobBookingId}/cancel`, { method: "PATCH", jar });
  check("cancelling someone else's booking -> 403", crossCancel.status === 403, `got ${crossCancel.status}`);

  const badCancelId = await api("/bookings/not-an-id/cancel", { method: "PATCH", jar });
  check("cancel invalid booking id -> 400", badCancelId.status === 400, `got ${badCancelId.status}`);

  const unknownCancel = await api("/bookings/000000000000000000000000/cancel", { method: "PATCH", jar });
  check("cancel unknown booking -> 404", unknownCancel.status === 404, `got ${unknownCancel.status}`);

  const cancelRes = await api(`/bookings/${bookingId}/cancel`, { method: "PATCH", jar });
  check("owner cancels own pending booking -> 200", cancelRes.status === 200, `got ${cancelRes.status} ${cancelRes.raw}`);

  const afterCancel = await api(`/my-bookings/${aliceEmail}`, { jar });
  const cancelled = Array.isArray(afterCancel.data) ? afterCancel.data.find((b) => String(b._id) === String(bookingId)) : null;
  check("booking status becomes Cancelled", cancelled?.status === "Cancelled", `got ${cancelled?.status}`);

  const cancelAgain = await api(`/bookings/${bookingId}/cancel`, { method: "PATCH", jar });
  check("cancelling twice -> 409", cancelAgain.status === 409, `got ${cancelAgain.status}`);

  // cleanup: Bob cancels his booking so no stray bookings remain
  await api(`/bookings/${bobBookingId}/cancel`, { method: "PATCH", jar: bobJar });
}

// ============================================================
console.log("\n--- Stage 4: booking validation & double booking prevention ---");
{
  const date = "2027-04-01";
  const book = (body) => api("/bookings", { method: "POST", jar, body: { studioId: bookingStudioId, ...body } });

  // --- validation ---
  const past = await book({ bookingDate: "2020-01-01", startTime: "10:00", endTime: "12:00" });
  check("past booking date -> 400", past.status === 400, `got ${past.status}`);

  // --- first booking on the slot ---
  const a = await book({ bookingDate: date, startTime: "10:00", endTime: "12:00" });
  check("booking A (10:00-12:00) created", a.status === 201, `got ${a.status} ${a.raw}`);
  const bookingA = a.data?.insertedId;

  // --- overlapping bookings are rejected with 409 ---
  const overlap1 = await book({ bookingDate: date, startTime: "11:00", endTime: "13:00" });
  check("partially overlapping booking -> 409", overlap1.status === 409, `got ${overlap1.status}`);

  const overlap2 = await book({ bookingDate: date, startTime: "10:30", endTime: "11:00" });
  check("fully contained booking -> 409", overlap2.status === 409, `got ${overlap2.status}`);

  const overlap3 = await book({ bookingDate: date, startTime: "10:00", endTime: "11:00" });
  check("same start time -> 409", overlap3.status === 409, `got ${overlap3.status}`);

  // --- non-overlapping bookings are accepted ---
  const adjacentEnd = await book({ bookingDate: date, startTime: "12:00", endTime: "14:00" });
  check("booking touching the end (12:00-14:00) -> 201", adjacentEnd.status === 201, `got ${adjacentEnd.status}`);

  const adjacentStart = await book({ bookingDate: date, startTime: "08:00", endTime: "10:00" });
  check("booking touching the start (08:00-10:00) -> 201", adjacentStart.status === 201, `got ${adjacentStart.status}`);

  const otherDay = await book({ bookingDate: "2027-04-02", startTime: "10:00", endTime: "12:00" });
  check("same time on another date -> 201", otherDay.status === 201, `got ${otherDay.status}`);

  // --- concurrency: two identical requests at the same time ---
  const [c1, c2] = await Promise.all([
    book({ bookingDate: "2027-04-03", startTime: "10:00", endTime: "12:00" }),
    book({ bookingDate: "2027-04-03", startTime: "10:00", endTime: "12:00" }),
  ]);
  const concurrentStatuses = [c1.status, c2.status].sort().join(",");
  check("concurrent identical bookings: only one succeeds", concurrentStatuses === "201,409", `got ${c1.status}, ${c2.status}`);

  // --- a Confirmed booking stored in the database also blocks the slot ---
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const bookings = mongoClient.db("studioSpace").collection("bookings");
  const studios = mongoClient.db("studioSpace").collection("studios");
  const confirmedDate = "2027-04-05";
  await bookings.insertOne({
    studioId: new ObjectId(bookingStudioId),
    studioTitle: "Sunset Recording Booth",
    userEmail: "manager@example.com",
    userName: "Studio Manager",
    bookingDate: confirmedDate,
    startTime: "09:00",
    endTime: "11:00",
    totalPrice: 40,
    status: "Confirmed",
    createdAt: new Date(),
  });

  const blocked = await book({ bookingDate: confirmedDate, startTime: "10:00", endTime: "12:00" });
  check("Confirmed booking blocks the slot -> 409", blocked.status === 409, `got ${blocked.status}`);

  const freePart = await book({ bookingDate: confirmedDate, startTime: "11:00", endTime: "13:00" });
  check("free part of the same day -> 201", freePart.status === 201, `got ${freePart.status}`);

  // --- a cancelled booking frees its slot ---
  const cancelA = await api(`/bookings/${bookingA}/cancel`, { method: "PATCH", jar });
  check("cancel booking A", cancelA.status === 200, `got ${cancelA.status} ${cancelA.raw}`);

  const rebook = await book({ bookingDate: date, startTime: "10:00", endTime: "12:00" });
  check("cancelled booking frees the slot -> 201", rebook.status === 201, `got ${rebook.status}`);

  // --- cleanup: remove everything these tests created ---
  const removedBookings = await bookings.deleteMany({ studioId: new ObjectId(bookingStudioId) });
  const removedStudio = await studios.deleteOne({ _id: new ObjectId(bookingStudioId) });
  check(
    "cleanup removed test bookings and studio",
    removedBookings.deletedCount > 0 && removedStudio.deletedCount === 1,
    `bookings: ${removedBookings.deletedCount}, studio: ${removedStudio.deletedCount}`
  );
  await mongoClient.close();
}

// ---- results ----
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
