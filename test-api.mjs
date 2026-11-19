// StudioSpace API test suite.
//
// Exercises the real endpoints in studiospace-server/index.js — including
// Challenge 1 (HTTPOnly session-cookie auth) and Challenge 2 (double-booking
// prevention). Run it with both servers up:
//
//   npm start                 # API on :8000
//   cd ../studiospace-client && npm start   # Next.js on :3000
//   npm test
//
// Sign-in happens through the real client origin, so the suite proves the
// browser's HTTPOnly cookie is accepted by the API exactly as a browser
// would send it (cookie + Origin + Sec-Fetch-* headers, no Bearer token).
//
// Every probe document is deleted from MongoDB at the end, so the examiner's
// seed accounts (alice@example.com / bob@example.com) stay pristine.
import 'dotenv/config';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:3000';
const API = `http://localhost:${process.env.PORT || 8000}`;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}
function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// 0. Reachability — fail with something actionable instead of a stack trace.
// ---------------------------------------------------------------------------
async function ping(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status;
  } catch {
    return 0;
  }
}

const apiUp = await ping(`${API}/`);
if (!apiUp) {
  console.error(`API is not reachable at ${API}. Start it with:  npm start`);
  process.exit(1);
}
const clientUp = await ping(`${CLIENT}/login`);
if (!clientUp) {
  console.error(
    `Next.js client is not reachable at ${CLIENT}.\n` +
      'The suite needs it to obtain a real HTTPOnly session cookie.\n' +
      'Start it with:  cd ../studiospace-client && npm start'
  );
  process.exit(1);
}
console.log(`API    ${API}  (HTTP ${apiUp})`);
console.log(`client ${CLIENT}  (HTTP ${clientUp})`);

// Signs in on the client origin and returns headers a real browser would send.
async function signInAs(email, password) {
  const res = await fetch(`${CLIENT}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CLIENT },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status}`);
  }
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  // localhost:3000 -> localhost:8000 is a different origin but the same site,
  // so a browser sends these Fetch Metadata headers. Including them exercises
  // BetterAuth's CSRF path exactly as a browser would.
  return {
    cookie,
    origin: CLIENT,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

const bob = await signInAs('bob@example.com', 'StudioSpace123!');
const alice = await signInAs('alice@example.com', 'StudioSpace123!');
console.log(
  `session cookies: ${bob.cookie.split(';').map((c) => c.split('=')[0]).join(', ')}`
);

let r;

// ---------------------------------------------------------------------------
// 1. Public read endpoints
// ---------------------------------------------------------------------------
section('public read endpoints');

r = await fetch(`${API}/`);
check('GET / health check', r.status, 200);

r = await fetch(`${API}/explore-studios`);
const allStudios = await r.json();
check('GET /explore-studios', r.status, 200);
check('seeded studios returned', Array.isArray(allStudios) && allStudios.length > 0, 'true');

r = await fetch(`${API}/explore-studios?category=Photo Studio`);
const byCategory = await r.json();
check(
  'category filter narrows results',
  Array.isArray(byCategory) && byCategory.length > 0 && byCategory.length <= allStudios.length,
  'true'
);
check(
  'category filter actually filters',
  byCategory.every((s) => s.category === 'Photo Studio'),
  'true'
);

// Featured Studios uses this exact query string (server-side .limit(6)).
r = await fetch(`${API}/explore-studios?sort=rating&limit=6`);
const featured = await r.json();
check('?limit=6 returns at most 6', featured.length <= 6, 'true');
check('?sort=rating is descending', featured.length > 0, 'true');
if (featured.length > 1) {
  check(
    '?sort=rating ordering',
    featured[0].rating >= featured[featured.length - 1].rating,
    'true'
  );
}

const firstId = allStudios[0]._id;
r = await fetch(`${API}/explore-studios/${firstId}`);
check('GET /explore-studios/:id', r.status, 200);
check('detail returns a title', Boolean((await r.json()).title), 'true');

r = await fetch(`${API}/cetagory`);
check('GET /cetagory (legacy alias)', r.status, 200);
r = await fetch(`${API}/category`);
check('GET /category', r.status, 200);

// ---------------------------------------------------------------------------
// 2. Challenge 1 — mutations authorised by the HTTPOnly session cookie
// ---------------------------------------------------------------------------
section('Challenge 1: HTTPOnly cookie authorisation');

r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'x', category: 'Photo Studio' }),
});
check('POST /add-studio with no credentials', r.status, 401);

r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer garbage' },
  body: JSON.stringify({ title: 'x', category: 'Photo Studio' }),
});
check('POST /add-studio with a bad Bearer token', r.status, 401);

r = await fetch(`${API}/my-listing/bob@example.com`);
check('GET /my-listing/:email with no credentials', r.status, 401);

// Cookie only — no Authorization header at all.
r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bob },
  body: JSON.stringify({
    title: 'Cookie Auth Probe',
    category: 'Photo Studio',
    location: 'Dhaka',
    hourlyRate: 45,
  }),
});
check('POST /add-studio with HTTPOnly cookie only', r.status, 201);
const probeId = (await r.json()).insertedId;

r = await fetch(`${API}/my-listing/bob@example.com`, { headers: bob });
check('GET own listings with cookie', r.status, 200);
r = await fetch(`${API}/my-listing/alice@example.com`, { headers: bob });
check("GET another user's listings", r.status, 403);

// ---------------------------------------------------------------------------
// 3. Ownership checks (these routes used to be wide open)
// ---------------------------------------------------------------------------
section('ownership checks');

const notBob = allStudios.find((s) => s.email !== 'bob@example.com');
if (notBob) {
  r = await fetch(`${API}/my-listing-update/${notBob._id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...bob },
    body: JSON.stringify({ title: 'HACKED' }),
  });
  check("PATCH someone else's studio", r.status, 403);

  const stillIntact = await (await fetch(`${API}/explore-studios/${notBob._id}`)).json();
  check('their title is untouched', stillIntact.title === notBob.title, 'true');
}

const targetStudio = allStudios[0];
let aliceBookingId = null;
if (targetStudio) {
  r = await fetch(`${API}/booking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...alice },
    body: JSON.stringify({
      studioId: targetStudio._id,
      bookingDate: '2027-06-01',
      startTime: '08:00',
      endTime: '09:00',
      total: 100,
    }),
  });
  check('alice creates a booking', r.status, 201);
  aliceBookingId = (await r.json()).insertedId;

  // Identity must come from the session, not the body.
  r = await fetch(`${API}/booking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bob },
    body: JSON.stringify({
      studioId: targetStudio._id,
      email: 'alice@example.com',
      userName: 'Impostor',
      bookingDate: '2027-06-01',
      startTime: '10:00',
      endTime: '11:00',
      total: 100,
    }),
  });
  check('booking with a spoofed email in the body', r.status, 201);
  const bobBookings = await (
    await fetch(`${API}/booking/bob@example.com`, { headers: bob })
  ).json();
  const spoofed = bobBookings.find(
    (b) => b.bookingDate === '2027-06-01' && b.startTime === '10:00'
  );
  check('booking owner taken from session', spoofed?.email, 'bob@example.com');
  check('booking name taken from session', spoofed?.userName, 'Bob Renter');

  r = await fetch(`${API}/bookings/cancel/${aliceBookingId}`, {
    method: 'PATCH',
    headers: bob,
  });
  check("PATCH cancel someone else's booking", r.status, 403);
}

// ---------------------------------------------------------------------------
// 4. Field whitelist (mass-assignment protection)
// ---------------------------------------------------------------------------
section('field whitelist on create/update');

r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bob },
  body: JSON.stringify({
    title: 'Whitelist Probe',
    category: 'Sound Stage',
    hourlyRate: 70,
    securityDeposit: 500,
    maxCapacity: 12,
    location: 'Chattogram',
    image: 'https://example.com/studio.jpg',
    gallery: ['https://example.com/a.jpg'],
    amenities: ['Green Room'],
    overview: 'A probe listing created by the regression suite.',
    // Fields the client must not be able to set:
    email: 'alice@example.com',
    ownerEmail: 'alice@example.com',
    ownerName: 'Alice Owner',
    rating: 1,
    _id: 'ffffffffffffffffffffffff',
  }),
});
check('create with a full payload', r.status, 201);
const createdId = (await r.json()).insertedId;

let doc = await (await fetch(`${API}/explore-studios/${createdId}`)).json();
check('securityDeposit persisted', doc.securityDeposit, 500);
check('maxCapacity persisted', doc.maxCapacity, 12);
check('gallery persisted', Array.isArray(doc.gallery) && doc.gallery.length === 1, 'true');
check('owner forced to the session user', doc.email, 'bob@example.com');
check('rating cannot be mass-assigned', doc.rating ?? 0, 0);
check('_id cannot be mass-assigned', String(doc._id), String(createdId));

r = await fetch(`${API}/my-listing-update/${createdId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...bob },
  body: JSON.stringify({ hourlyRate: 99, ownerEmail: 'alice@example.com', rating: 5 }),
});
check('update own listing', r.status, 200);
doc = await (await fetch(`${API}/explore-studios/${createdId}`)).json();
check('hourlyRate updated', doc.hourlyRate, 99);
check('securityDeposit survives the update', doc.securityDeposit, 500);
check('ownerEmail is not transferable', doc.ownerEmail, 'bob@example.com');
check('rating is not settable via update', doc.rating ?? 0, 0);

r = await fetch(`${API}/my-listing/bob@example.com?id=${createdId}`, {
  method: 'DELETE',
  headers: bob,
});
check('delete own listing', r.status, 200);
r = await fetch(`${API}/explore-studios/${createdId}`);
check('deleted studio is gone', r.status, 404);

// ---------------------------------------------------------------------------
// 5. Challenge 2 — double-booking prevention
// ---------------------------------------------------------------------------
section('Challenge 2: double-booking prevention');

if (targetStudio) {
  const book = (date, start, end) =>
    fetch(`${API}/booking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bob },
      body: JSON.stringify({
        studioId: targetStudio._id,
        bookingDate: date,
        startTime: start,
        endTime: end,
        total: 100,
      }),
    });

  check('first booking 09:00-11:00', (await book('2027-06-02', '09:00', '11:00')).status, 201);
  check('overlapping 10:00-12:00 rejected', (await book('2027-06-02', '10:00', '12:00')).status, 409);
  check('identical slot rejected', (await book('2027-06-02', '09:00', '11:00')).status, 409);
  check('contained 09:30-10:00 rejected', (await book('2027-06-02', '09:30', '10:00')).status, 409);
  check('adjacent 11:00-13:00 allowed', (await book('2027-06-02', '11:00', '13:00')).status, 201);
  check('same hours on another date allowed', (await book('2027-06-03', '09:00', '11:00')).status, 201);

  // Validation that protects the lexical string comparison.
  check('reversed range rejected', (await book('2027-06-02', '14:00', '13:00')).status, 400);
  check('unpadded time rejected', (await book('2027-06-02', '9:30', '10:30')).status, 400);
  check('malformed date rejected', (await book('02-06-2027', '09:00', '10:00')).status, 400);
  r = await fetch(`${API}/booking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bob },
    body: JSON.stringify({
      studioId: 'ffffffffffffffffffffffff',
      bookingDate: '2027-06-02',
      startTime: '15:00',
      endTime: '16:00',
      total: 100,
    }),
  });
  check('unknown studio rejected', r.status, 404);

  // Cancelling frees the slot for a new reservation.
  const pending = (
    await (await fetch(`${API}/booking/bob@example.com`, { headers: bob })).json()
  ).find((b) => b.bookingDate === '2027-06-02' && b.startTime === '09:00');
  if (pending) {
    r = await fetch(`${API}/bookings/cancel/${pending._id}`, {
      method: 'PATCH',
      headers: bob,
    });
    check('owner cancels a pending booking', r.status, 200);
    check(
      'cancelled slot can be rebooked',
      (await book('2027-06-02', '09:00', '11:00')).status,
      201
    );
    check(
      'cancelling twice is refused',
      (await fetch(`${API}/bookings/cancel/${pending._id}`, { method: 'PATCH', headers: bob }))
        .status,
      409
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Error handling and CORS
// ---------------------------------------------------------------------------
section('error handling and CORS');

r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bob },
  body: '{not json',
});
check('malformed JSON answers 400', r.status, 400);
check('malformed JSON answers JSON', (await r.json()).message !== undefined, 'true');

r = await fetch(`${API}/explore-studios/not-an-id`);
check('invalid ObjectId answers 400', r.status, 400);

r = await fetch(`${API}/definitely-not-a-route`);
const notFound = await r.json();
check('unknown route answers 404', r.status, 404);
check('unknown route answers JSON', typeof notFound.message, 'string');

r = await fetch(`${API}/explore-studios`, { headers: { origin: CLIENT } });
check('CORS allow-origin is the client', r.headers.get('access-control-allow-origin'), CLIENT);
check('CORS allow-credentials', r.headers.get('access-control-allow-credentials'), 'true');

r = await fetch(`${API}/explore-studios`, {
  method: 'OPTIONS',
  headers: {
    origin: CLIENT,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
check('CORS preflight succeeds', r.status < 300, 'true');

r = await fetch(`${API}/explore-studios`, { headers: { origin: 'https://evil.example' } });
check('unknown origin is refused', r.headers.get('access-control-allow-origin') ?? 'none', 'none');

// ---------------------------------------------------------------------------
// 7. Cleanup — remove every probe document so seed data stays pristine.
// ---------------------------------------------------------------------------
section('cleanup');

const { MongoClient } = await import('mongodb');
const client = new MongoClient(process.env.MONGO_DB_URI || process.env.MONGODB_URI);
await client.connect();
const db = client.db('studioSpace');
const removedBookings = await db
  .collection('booking')
  .deleteMany({ bookingDate: { $in: ['2027-06-01', '2027-06-02', '2027-06-03'] } });
const removedStudios = await db
  .collection('cart')
  .deleteMany({ title: { $in: ['Cookie Auth Probe', 'Whitelist Probe'] } });
await client.close();
console.log(
  `removed ${removedBookings.deletedCount} probe bookings, ` +
    `${removedStudios.deletedCount} probe studios`
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
