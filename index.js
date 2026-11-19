import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { connectToMongoDB, getDb } from './db.js';
import { requireAuth, isOwner } from './auth.js';

const app = express();
// Default matches the client's NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SERVER_URL
// (http://localhost:8000) and test-api.mjs. Render injects PORT at runtime.
const PORT = process.env.PORT || 8000;

// Where the Next.js client is served from. Used for CORS (cookie auth needs a
// specific origin + `credentials: true`, never `*`) and for BetterAuth's JWKS.
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

app.use(express.json());

// Challenge 1 relies on an HTTPOnly cookie crossing from the client origin to
// this API, so CORS must allow that one origin *with* credentials.
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / server-to-server calls (no Origin header)
      // and any origin explicitly listed in CLIENT_URL (comma separated).
      const allowed = CLIENT_URL.split(',').map((o) => o.trim());
      if (!origin || allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// Connect once before serving so the health check only passes when the
// database is actually reachable.
await connectToMongoDB();
const db = getDb();

const categoryData = db.collection('category');
// NOTE: the studios collection is named `cart` — a legacy name from the
// original scaffold. The seeded listings live here; renaming would orphan
// them, so the name is kept and only the variable is spelled clearly.
const studiosData = db.collection('cart');
const bookingData = db.collection('booking');
// Saved-studios wishlist: one doc per { email, studioId } pair.
const wishlistData = db.collection('wishlist');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses an id param. Answers 400 (not an HTML 500) when it isn't an ObjectId. */
function parseId(req, res) {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    res.status(400).json({ message: 'Invalid id.' });
    return null;
  }
  return new ObjectId(id);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check used by Render (`healthCheckPath: /`).
app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Categories (kept as `/cetagory` for the original client, plus a corrected
// alias so the endpoint also answers at `/category`).
async function sendCategories(req, res) {
  const result = await categoryData.find({}).toArray();
  res.send(result);
}
app.get('/cetagory', sendCategories);
app.get('/category', sendCategories);

// All studio data + optional category filter + optional limit.
// `?limit=6` is what the home page's Featured Studios section uses so the
// server, not the client, truncates the result set.
app.get('/explore-studios', async (req, res) => {
  const { category, limit } = req.query;
  const filter = {};
  if (category) filter.category = category;

  let cursor = studiosData.find(filter).sort({ createdAt: -1 });
  const n = Number.parseInt(limit, 10);
  if (Number.isFinite(n) && n > 0) cursor = cursor.limit(n);

  const result = await cursor.toArray();
  res.send(result);
});

// Studio details.
app.get('/explore-studios/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const result = await studiosData.findOne({ _id: id });
  if (!result) return res.status(404).json({ message: 'Studio not found.' });
  res.send(result);
});

// Create a studio. Only the whitelisted fields are persisted so a client
// cannot mass-assign `rating`, `_id`, `email`, etc.
const STUDIO_FIELDS = [
  'title', 'category', 'location', 'hourlyRate', 'deposit', 'capacity',
  'image', 'amenities', 'overview', 'email', 'userName', 'createdAt',
];
app.post('/add-studio', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.title || !body.category) {
    return res.status(400).json({ message: 'Title and category are required.' });
  }

  const doc = {};
  for (const key of STUDIO_FIELDS) {
    if (body[key] !== undefined) doc[key] = body[key];
  }
  // The authenticated user is always the owner, whatever the body claimed.
  doc.email = req.user.email;
  doc.userName = req.user.name;
  doc.createdAt = new Date();

  const result = await studiosData.insertOne(doc);
  res.status(201).json(result);
});

// Probe endpoint kept for backwards compatibility with older clients.
app.get('/add-studio', requireAuth, (req, res) => {
  res.status(200).send('Authorized');
});

// A user's own listings. The caller must be that user.
app.get('/my-listing/:email', requireAuth, async (req, res) => {
  const { email } = req.params;
  if (String(email).toLowerCase() !== String(req.user.email).toLowerCase()) {
    return res.status(403).json({ message: 'You can only view your own listings.' });
  }
  const result = await studiosData.find({ email }).toArray();
  res.send(result);
});

// Data for the edit form.
app.get('/my-listing-edit/:id', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const result = await studiosData.findOne({ _id: id });
  if (!result) return res.status(404).json({ message: 'Studio not found.' });
  if (!isOwner(result, req.user)) {
    return res.status(403).json({ message: 'You can only edit your own listings.' });
  }
  res.send(result);
});

// Update a studio. Protected + ownership checked + field whitelist.
app.patch('/my-listing-update/:id', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;

  const existing = await studiosData.findOne({ _id: id });
  if (!existing) return res.status(404).json({ message: 'Studio not found.' });
  if (!isOwner(existing, req.user)) {
    return res.status(403).json({ message: 'You can only update your own listings.' });
  }

  const body = req.body || {};
  const updates = {};
  for (const key of STUDIO_FIELDS) {
    if (body[key] !== undefined && key !== 'email') updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: 'No editable fields supplied.' });
  }

  const result = await studiosData.updateOne({ _id: id }, { $set: updates });
  res.json(result);
});

// Delete a studio. With `?id=` only that studio is removed; without it the
// owner's listings are targeted by email (legacy client behaviour).
app.delete('/my-listing/:email', requireAuth, async (req, res) => {
  const { email } = req.params;
  const { id } = req.query;

  if (String(email).toLowerCase() !== String(req.user.email).toLowerCase()) {
    return res.status(403).json({ message: 'You can only delete your own listings.' });
  }

  if (id) {
    const oid = parseId(req, res);
    if (!oid) return;
    const existing = await studiosData.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ message: 'Studio not found.' });
    if (!isOwner(existing, req.user)) {
      return res.status(403).json({ message: 'You can only delete your own listings.' });
    }
    const result = await studiosData.deleteOne({ _id: oid });
    return res.send(result);
  }

  // No id supplied: refuse rather than deleting an arbitrary document.
  return res
    .status(400)
    .json({ message: 'A studio id (?id=) is required to delete a listing.' });
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

// Creates a booking, preventing double-booking of overlapping slots.
// Challenge 2: `Pending` and `Confirmed` both hold their slot; `Cancelled`
// frees it. Overlap uses the half-open interval rule
//   existing.start < new.end && existing.end > new.start
// so touching slots (11:00 -> 11:00) are allowed.
app.post('/booking', requireAuth, async (req, res) => {
  const data = req.body || {};
  const { studioId, bookingDate, startTime, endTime } = data;

  if (!studioId || !bookingDate || !startTime || !endTime) {
    return res.status(400).json({
      message: 'studioId, bookingDate, startTime and endTime are required.',
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
    return res.status(400).json({ message: 'bookingDate must be YYYY-MM-DD.' });
  }
  // Zero-padded HH:MM keeps the string comparison below correct.
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ message: 'Times must be zero-padded HH:MM.' });
  }
  if (endTime <= startTime) {
    return res.status(400).json({ message: 'endTime must be after startTime.' });
  }
  if (!ObjectId.isValid(studioId)) {
    return res.status(400).json({ message: 'Invalid studioId.' });
  }

  const studio = await studiosData.findOne({ _id: new ObjectId(studioId) });
  if (!studio) return res.status(404).json({ message: 'Studio not found.' });

  const existingBooking = await bookingData.findOne({
    studioId,
    bookingDate,
    // Both Pending and Confirmed bookings hold their time slot.
    status: { $in: ['Pending', 'Confirmed'] },
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  });

  if (existingBooking) {
    return res.status(409).json({
      message: 'This studio is already booked for this time!',
    });
  }

  // Identity always comes from the session, never from the request body.
  const result = await bookingData.insertOne({
    ...data,
    email: req.user.email,
    userName: req.user.name,
    studioTitle: studio.title,
    status: 'Pending',
    createdAt: new Date(),
  });

  res.status(201).json(result);
});

// A user's own bookings. The caller must be that user.
app.get('/booking/:email', requireAuth, async (req, res) => {
  const { email } = req.params;
  if (String(email).toLowerCase() !== String(req.user.email).toLowerCase()) {
    return res.status(403).json({ message: 'You can only view your own bookings.' });
  }
  const result = await bookingData.find({ email }).toArray();
  res.send(result);
});

// Cancel a pending booking (only the booking's owner may do this).
app.patch('/bookings/cancel/:id', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;

  const existing = await bookingData.findOne({ _id: id });
  if (!existing) return res.status(404).json({ message: 'Booking not found.' });
  if (!isOwner(existing, req.user)) {
    return res.status(403).json({ message: 'You can only cancel your own bookings.' });
  }
  if (existing.status !== 'Pending') {
    return res
      .status(409)
      .json({ message: `Only pending bookings can be cancelled (this one is ${existing.status}).` });
  }

  const result = await bookingData.updateOne(
    { _id: id, status: 'Pending' },
    { $set: { status: 'Cancelled' } }
  );
  res.send(result);
});

// ---------------------------------------------------------------------------
// Wishlist
// ---------------------------------------------------------------------------

// List the studios a user has saved.
app.get('/wishlist/:email', requireAuth, async (req, res) => {
  const { email } = req.params;
  if (String(email).toLowerCase() !== String(req.user.email).toLowerCase()) {
    return res.status(403).json({ message: 'You can only view your own wishlist.' });
  }
  const result = await wishlistData.find({ email }).toArray();
  res.send(result);
});

// Add/remove a studio from the wishlist (returns the new saved state).
app.post('/wishlist/toggle', requireAuth, async (req, res) => {
  const { studioId } = req.body || {};
  if (!studioId) {
    return res.status(400).json({ message: 'studioId is required.' });
  }
  const email = req.user.email; // identity from the session, not the body

  const existing = await wishlistData.findOne({ email, studioId });
  if (existing) {
    await wishlistData.deleteOne({ _id: existing._id });
    return res.send({ saved: false });
  }
  await wishlistData.insertOne({ email, studioId, createdAt: new Date() });
  res.send({ saved: true });
});

app.post('/', (req, res) => {
  res.send('home');
});

// ---------------------------------------------------------------------------
// Error handling — everything below answers JSON, never an HTML stack trace.
// ---------------------------------------------------------------------------

// Unknown routes.
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Malformed JSON, thrown CORS errors, and anything an async handler rejects.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed JSON in request body.' });
  }
  if (String(err?.message || '').startsWith('CORS blocked')) {
    return res.status(403).json({ message: err.message });
  }
  if (err?.name === 'BSONError' || String(err?.name) === 'BSONError') {
    return res.status(400).json({ message: 'Invalid id.' });
  }
  console.error('[api] error:', err.message);
  // Never expose the stack trace to the client.
  res.status(500).json({ message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`StudioSpace API listening on port ${PORT}`);
});

export default app;
