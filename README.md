# StudioSpace Backend

Backend server for **B14-A8-Cat_Harry – StudioSpace**, a studio booking
platform. It exposes a REST API for studios and bookings and handles
authentication with BetterAuth.

## Technologies

- Node.js (ES Modules)
- Express.js
- MongoDB Native Driver (no Mongoose)
- BetterAuth + BetterAuth MongoDB Adapter (registration, login, sessions, JWT)
- dotenv
- cors (with credentials)
- HTTPOnly session cookies

## Project structure

```
studiospace-server/
├── index.js        # Express server, API routes, auth middleware, error handling
├── auth.js         # BetterAuth configuration (MongoDB adapter + JWT plugin)
├── db.js           # Shared MongoDB client, database and collections
├── test-api.mjs    # Automated API test suite
├── .env.example    # Environment variable template (placeholders only)
└── package.json
```

Database: **`studioSpace`** with the collections `users`, `studios`,
`bookings` (plus BetterAuth's internal `session`, `account`, `verification`,
`jwks` collections and the internal `bookingLocks` collection).

## Installation

```bash
npm install
```

## Environment variables

Copy the template and fill in your own values (never commit `.env`):

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `PORT` | Server port (default `8000`) |
| `MONGODB_URI` | MongoDB connection string |
| `CLIENT_URL` | Frontend origin allowed to call the API with credentials |
| `BETTER_AUTH_SECRET` | Secret used by BetterAuth to sign cookies and encrypt JWT keys |
| `BETTER_AUTH_URL` | Public URL of this backend (use `https://` in production) |
| `JWT_SECRET` | Fallback secret if `BETTER_AUTH_SECRET` is not set |
| `COOKIE_SAMESITE` | Optional. `none` when frontend and backend are on different domains (requires https) |

## Run the server

```bash
node index.js
# or
npm start
```

The server starts on `http://localhost:8000`, connects to MongoDB and
creates the required indexes.

## Run the tests

Start the server first, then in a second terminal:

```bash
node test-api.mjs
```

The suite covers authentication, studio CRUD security, bookings, validation
and double booking prevention.

## API endpoints

### Public

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/` | Server status |
| GET | `/studios` | All studios |
| GET | `/featured-studios` | Six highest rated / newest studios |
| GET | `/studio/:id` | Studio details by id |

### Authentication (BetterAuth, mounted at `/api/auth`)

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/api/auth/sign-up/email` | Register (`name`, `email`, `password`, optional `photoURL`) |
| POST | `/api/auth/sign-in/email` | Login (`email`, `password`) |
| POST | `/api/auth/sign-out` | Logout |
| GET | `/api/auth/get-session` | Current session/user (persists across reloads) |
| GET | `/api/auth/token` | Signed JWT for the logged in user |

### Studios (protected)

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/add-studio` | Add a studio (owner comes from the session) |
| GET | `/my-listings/:email` | Own listings only (403 for other emails) |
| PATCH | `/studio/:id` | Update own studio (403 for other owners) |
| DELETE | `/studio/:id` | Delete own studio (403 for other owners) |

Studio body fields: `title`, `category`, `hourlyRate`, `securityDeposit`,
`maxCapacity`, `location`, `image`, `amenities`, `overview`. Ownership
fields (`ownerName`, `ownerEmail`, `rating`, timestamps) are always set by
the server.

### Bookings (protected)

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/bookings` | Create a booking (`studioId`, `bookingDate`, `startTime`, `endTime`) |
| GET | `/my-bookings/:email` | Own bookings only (403 for other emails) |
| PATCH | `/bookings/:id/cancel` | Cancel own `Pending` booking |

Booking rules:

- New bookings get status `Pending`; cancelling sets it to `Cancelled`.
- `userEmail`, `userName` and `totalPrice` are always computed on the
  server – values sent by the client are ignored.
- `totalPrice = hourlyRate × (endTime − startTime)` in hours.
- Only `Pending` bookings can be cancelled (otherwise HTTP 409).

### Status codes

| Code | Meaning |
| --- | --- |
| 400 | Invalid input (bad id, date, time, missing fields, invalid JSON) |
| 401 | Not authenticated (no valid session cookie) |
| 403 | Authenticated but not allowed (someone else's data) |
| 404 | Record or route not found |
| 409 | Booking time conflict / booking state conflict |
| 500 | Unexpected server error (generic message, no stack traces) |

## Authentication and cookies

- BetterAuth with the **MongoDB Adapter** stores users in the `users`
  collection (passwords are hashed by BetterAuth and never returned).
- Sessions are stored in **HTTPOnly** cookies, so JavaScript cannot read
  them. Cookies become `Secure` automatically when `BETTER_AUTH_URL`
  uses `https://`.
- CORS is configured with `credentials: true` and `CLIENT_URL`, so the
  frontend can send cookies cross-origin.
- Protected routes call `auth.api.getSession()` with the request headers.
  Identity always comes from the **verified session**, never from an email
  in the request body, and requests without a session get **401**.
- The official BetterAuth **JWT plugin** provides JWT support
  (`GET /api/auth/token` returns a signed JWT with `sub`, `iss` and `exp`).

## Booking conflict prevention (double booking)

A simple "check then insert" is **not** race safe: two requests could both
check at the same time, both see a free slot and both insert. This server
therefore uses two layers:

1. **Per studio + date lock** – a document with a unique `_id`
   (`studioId_date`) is inserted into the `bookingLocks` collection.
   `insertOne` is atomic, so only one request can hold the lock; the others
   wait and retry. Expired locks (older than 20 s) are removed automatically.
2. **Overlap check inside the lock** – existing `Pending`/`Confirmed`
   bookings for the same studio and date are compared with:

   ```
   newStart < existingEnd  &&  newEnd > existingStart
   ```

   A match returns **409 Conflict**; non-overlapping (including touching)
   slots are accepted.
3. **Transaction** – the check and the insert run inside a MongoDB
   transaction when the deployment supports it (detected at startup;
   MongoDB Atlas replica sets do). On standalone MongoDB the server falls
   back to plain writes, and the lock still serializes the requests.

Cancelled bookings do not hold their time slot.

## Security notes

- No credentials or secrets are stored in the repository (`.env` is
  gitignored, `.env.example` contains placeholders only).
- Input validation for ids (`ObjectId`), dates (`YYYY-MM-DD`, not in the
  past), times (`HH:MM`, end after start) and numeric studio fields.
- Only whitelisted fields can be updated on a studio.
- Centralized error handler returns safe generic messages.
