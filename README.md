# StudioSpace Backend

REST API for **B14-A8-Cat_Harry – StudioSpace**, a peer-to-peer creative
workspace and studio booking marketplace. Serves studio listings, bookings and
the wishlist, and authenticates every mutation from BetterAuth's **HTTPOnly
session cookie**.

## Technologies

- Node.js (ES Modules) + Express 5
- MongoDB Native Driver (no Mongoose)
- BetterAuth + BetterAuth MongoDB Adapter + JWT — sessions and users live in
  the same `studioSpace` database the client writes to
- `jose` for Bearer-JWT verification against the client's JWKS (fallback path)
- `cors` with `credentials: true`, `dotenv`

## Project structure

```
studiospace-server/
├── index.js         # Express app: routes, validation, error handling
├── auth.js          # BetterAuth instance + requireAuth middleware + isOwner
├── db.js            # Shared MongoDB client/connection
├── test-api.mjs     # 61-assertion test suite (npm test)
├── .env.example     # Template with placeholders only
├── render.yaml      # Render deploy blueprint
└── package.json
```

Database: **`studioSpace`**

| Collection | Contents |
| --- | --- |
| `cart` | Studio listings (legacy name kept — the seed data lives here) |
| `booking` | Reservations with a `status` of `Pending`/`Confirmed`/`Completed`/`Cancelled` |
| `wishlist` | One document per `{ email, studioId }` pair |
| `category` | Studio categories (the client currently uses a static list) |
| `users`, `session`, `account`, `verification`, `jwks` | BetterAuth internals |

## Installation

```bash
npm install
cp .env.example .env   # then fill in real values
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `MONGO_DB_URI` | yes | MongoDB connection string (`MONGODB_URI` also accepted) |
| `BETTER_AUTH_SECRET` | yes | **Must match the client's value exactly** — the session cookie is signed with it, and a mismatch makes every cookie-authenticated request return 401 |
| `CLIENT_URL` | yes | Frontend origin(s), comma separated. Drives CORS and `trustedOrigins` |
| `BETTER_AUTH_URL` | no | BetterAuth `baseURL`; falls back to `CLIENT_URL` |
| `PORT` | no | Defaults to `8000`. Render injects this at runtime |

Never commit `.env`; `.env.example` contains placeholders only.

## Run

```bash
npm start          # http://localhost:8000
```

The process connects to MongoDB before listening, so the health check only
passes once the database is reachable.

## Test

Both servers must be running (the suite obtains a real session cookie from the
client):

```bash
npm start                                  # terminal 1 — API on :8000
cd ../studiospace-client && npm start      # terminal 2 — Next.js on :3000
npm test                                   # terminal 1
```

`npm test` exits `0` on success. Every probe document is deleted from MongoDB
afterwards, so the seed accounts stay pristine.

## API endpoints

### Public

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/` | Health check (Render `healthCheckPath`) |
| GET | `/explore-studios` | All studios. Supports `?category=`, `?sort=rating`, `?limit=6` |
| GET | `/explore-studios/:id` | One studio |
| GET | `/cetagory`, `/category` | Category list |

### Protected — requires the HTTPOnly session cookie (otherwise **401**)

| Method | Endpoint | Notes |
| --- | --- | --- |
| POST | `/add-studio` | Creates a listing; owner comes from the session |
| GET | `/add-studio` | Auth probe, kept for older clients |
| GET | `/my-listing/:email` | **403** unless `:email` is the session user |
| GET | `/my-listing-edit/:id` | **403** unless you own the listing |
| PATCH | `/my-listing-update/:id` | **403** for other owners |
| DELETE | `/my-listing/:email?id=<id>` | **403** for other owners; `id` is required |
| POST | `/booking` | Creates a `Pending` booking |
| GET | `/booking/:email` | **403** unless `:email` is the session user |
| PATCH | `/bookings/cancel/:id` | Own **Pending** booking only, else **403**/**409** |
| GET | `/wishlist/:email` | **403** unless `:email` is the session user |
| POST | `/wishlist/toggle` | `{ studioId }` — returns `{ saved: boolean }` |

### Authentication (served by the client at `CLIENT_URL/api/auth`)

BetterAuth runs inside the Next.js app, not here:

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/auth/sign-up/email` | Register |
| POST | `/api/auth/sign-in/email` | Login — sets the HTTPOnly session cookie |
| GET | `/api/auth/get-session` | Current session |
| GET | `/api/auth/token` | Signed JWT (Bearer fallback) |
| GET | `/api/auth/jwks` | Public keys this server verifies Bearer tokens against |

## Status codes

| Code | Meaning |
| --- | --- |
| 200 / 201 | Success / resource created |
| 400 | Invalid input — bad id, date, time, missing field, malformed JSON |
| 401 | Not authenticated — no valid session cookie |
| 403 | Authenticated but not allowed — someone else's data, or disallowed origin |
| 404 | Record or route not found |
| 409 | Booking time conflict, or invalid booking state transition |
| 500 | Unexpected error — generic JSON message, never a stack trace |

## Authentication (Challenge 1)

- Every mutation is guarded by `requireAuth` in `auth.js`.
- The middleware rebuilds the **same** BetterAuth instance against the **same**
  database and secret, then calls `auth.api.getSession()` with the incoming
  headers — so the browser's `better-auth.session_token` HTTPOnly cookie is
  verified here on the API origin.
- A `Authorization: Bearer <jwt>` header verified against the client's JWKS is
  kept as a fallback for scripts and older clients.
- Failures always answer `401 { "message": "Unauthorized" }` as JSON — an
  invalid token used to throw and leak an HTML stack trace.
- Identity (`email`, `name`) always comes from the **verified session**, never
  from the request body, so a caller cannot create records as another user.
- `isOwner()` enforces ownership before any update, delete or cancel.
- CORS is restricted to `CLIENT_URL` with `credentials: true`. Cookies are
  `HttpOnly` + `SameSite=Lax` locally, and switch to `SameSite=None; Secure`
  automatically when `BETTER_AUTH_URL` is `https://` (required once the client
  and API are on different domains).

## Booking conflict prevention (Challenge 2)

Before inserting, the server looks for an existing booking where all of:

```
studioId   matches
bookingDate matches
status     in ["Pending", "Confirmed"]     // Cancelled frees the slot
startTime  <  new endTime
endTime    >  new startTime
```

That is the standard half-open interval overlap test, so touching slots
(`11:00 → 11:00`) are correctly allowed. A collision answers **409** with
`"This studio is already booked for this time!"`.

Input validation protects the comparison itself: `bookingDate` must be
`YYYY-MM-DD`, times must be zero-padded `HH:MM` (otherwise the lexical string
comparison could be bypassed by `9:30`), `endTime` must follow `startTime`, and
the studio must exist.

> Known limitation: the check-then-insert is not transactional, so two requests
> arriving in the same instant could theoretically both pass the check. Making
> it race-proof requires a MongoDB transaction (available on Atlas replica
> sets).

## Input handling

- Create and update accept a **field whitelist** — `title`, `category`,
  `hourlyRate`, `securityDeposit`, `maxCapacity`, `location`, `image`,
  `gallery`, `amenities`, `overview`. `rating`, `_id`, `ownerEmail` and
  `ownerName` cannot be mass-assigned, and ownership is never editable.
- Unknown routes answer JSON `404`; malformed JSON answers `400`; every async
  rejection is funnelled through one error handler that returns a generic
  message instead of a stack trace.
