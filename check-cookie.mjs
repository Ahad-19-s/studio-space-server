// Focused check: does Challenge 1 (HTTPOnly session cookie) now authenticate
// mutations on the API origin? Run with the server already listening.
import 'dotenv/config';

const CLIENT = 'http://localhost:3000';
const API = 'http://localhost:8000';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}

// 1. Sign in on the client origin to obtain the HTTPOnly cookie.
async function signInAs(email, password) {
  const res = await fetch(`${CLIENT}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CLIENT },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  // localhost:3000 -> localhost:8000 is a different origin but the same site,
  // so a real browser sends these Fetch Metadata headers. Including them here
  // means the test exercises BetterAuth's CSRF path exactly as a browser would.
  return {
    cookie,
    origin: CLIENT,
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

const withCookie = await signInAs('bob@example.com', 'StudioSpace123!');
const alice = await signInAs('alice@example.com', 'StudioSpace123!');
console.log('cookies:', withCookie.cookie.split(';').map((c) => c.split('=')[0]).join(', '));

// 2. No credentials at all -> 401.
let r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'x', category: 'Photo Studio' }),
});
check('POST /add-studio without auth', r.status, 401);

// 3. Cookie only (no Bearer) -> 201. This is Challenge 1.
r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...withCookie },
  body: JSON.stringify({
    title: 'Cookie Auth Probe',
    category: 'Photo Studio',
    location: 'Dhaka',
    hourlyRate: 45,
  }),
});
check('POST /add-studio with HTTPOnly cookie', r.status, 201);
const created = await r.json();
const probeId = created.insertedId;

// 4. Own listings -> 200; someone else's -> 403.
r = await fetch(`${API}/my-listing/bob@example.com`, { headers: withCookie });
check('GET own listings with cookie', r.status, 200);
r = await fetch(`${API}/my-listing/alice@example.com`, { headers: withCookie });
check('GET other user listings', r.status, 403);

// 5. Update someone else's studio -> 403 (was completely open before).
const aliceStudio = await (await fetch(`${API}/explore-studios`)).json();
const notBob = aliceStudio.find((s) => s.email !== 'bob@example.com');
if (notBob) {
  r = await fetch(`${API}/my-listing-update/${notBob._id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...withCookie },
    body: JSON.stringify({ title: 'HACKED' }),
  });
  check('PATCH someone elses studio', r.status, 403);
}

// 6. Cancel someone else's booking -> 403 (was completely open before).
//    Alice creates a booking; Bob must not be able to cancel it.
const studios = await (await fetch(`${API}/explore-studios`)).json();
const targetStudio = studios[0];
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

  // Identity must come from the session: Bob cannot book on Alice's behalf
  // even if he puts her email in the body.
  r = await fetch(`${API}/booking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...withCookie },
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
  check('spoofed-body booking accepted', r.status, 201);
  const bobBookings = await (
    await fetch(`${API}/booking/bob@example.com`, { headers: withCookie })
  ).json();
  const spoofed = bobBookings.find(
    (b) => b.bookingDate === '2027-06-01' && b.startTime === '10:00'
  );
  check('booking identity from session, not body', spoofed?.email, 'bob@example.com');
  check('booking name from session, not body', spoofed?.userName, 'Bob Renter');

  r = await fetch(`${API}/bookings/cancel/${aliceBookingId}`, {
    method: 'PATCH',
    headers: withCookie,
  });
  check('PATCH cancel someone elses booking', r.status, 403);
}

// 7. Malformed JSON -> 400 JSON, not an HTML 500.
r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...withCookie },
  body: '{not json',
});
check('malformed JSON body', r.status, 400);

// 8. Invalid ObjectId -> 400 JSON, not an HTML 500.
r = await fetch(`${API}/explore-studios/not-an-id`, { headers: withCookie });
check('invalid ObjectId', r.status, 400);

// 9. Unknown route -> JSON 404.
r = await fetch(`${API}/definitely-not-a-route`);
const notFound = await r.json();
check('unknown route status', r.status, 404);
check('unknown route is JSON', typeof notFound.message, 'string');

// 10. Bad token -> 401, not 500.
r = await fetch(`${API}/add-studio`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer garbage' },
  body: JSON.stringify({ title: 'x', category: 'Photo Studio' }),
});
check('invalid Bearer token', r.status, 401);

// 11. CORS: credentials allowed for the client origin.
r = await fetch(`${API}/explore-studios`, {
  headers: { origin: CLIENT },
});
check('CORS allow-origin', r.headers.get('access-control-allow-origin'), CLIENT);
check('CORS allow-credentials', r.headers.get('access-control-allow-credentials'), 'true');

// 12. Challenge 2 — double-booking prevention, re-verified after the refactor.
if (targetStudio) {
  const mk = (start, end) =>
    fetch(`${API}/booking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withCookie },
      body: JSON.stringify({
        studioId: targetStudio._id,
        bookingDate: '2027-06-02',
        startTime: start,
        endTime: end,
        total: 100,
      }),
    });

  check('first booking 09:00-11:00', (await mk('09:00', '11:00')).status, 201);
  check('overlapping 10:00-12:00 rejected', (await mk('10:00', '12:00')).status, 409);
  check('identical slot rejected', (await mk('09:00', '11:00')).status, 409);
  check('adjacent 11:00-13:00 allowed', (await mk('11:00', '13:00')).status, 201);
  check('reversed range rejected', (await mk('14:00', '13:00')).status, 400);
  check('unpadded time rejected', (await mk('9:30', '10:30')).status, 400);
}

// 13. Cleanup everything this script created (removes the docs entirely so
//     the examiner's My Bookings page stays exactly as seeded).
const { MongoClient } = await import('mongodb');
const client = new MongoClient(process.env.MONGO_DB_URI || process.env.MONGODB_URI);
await client.connect();
const db = client.db('studioSpace');
const removedBookings = await db
  .collection('booking')
  .deleteMany({ bookingDate: { $in: ['2027-06-01', '2027-06-02'] } });
const removedStudios = await db
  .collection('cart')
  .deleteMany({ title: 'Cookie Auth Probe' });
await client.close();
console.log(
  `cleaned up ${removedBookings.deletedCount} probe bookings, ${removedStudios.deletedCount} probe studios`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
