// Shared MongoDB connection for the StudioSpace API.
//
// One client is reused by both the route handlers (index.js) and the
// BetterAuth instance (auth.js) so the API and the session store always
// read from the same `studioSpace` database.
import { MongoClient } from "mongodb";

const MONGO_URI =
  process.env.MONGO_DB_URI || process.env.MONGODB_URI || "";

// Fail fast with a message an operator can act on instead of the driver's
// `undefined.startsWith is not a function` TypeError.
if (!MONGO_URI) {
  console.error(
    "[studiospace-server] Missing MONGO_DB_URI (or MONGODB_URI). " +
      "Copy the connection string into studiospace-server/.env and restart."
  );
  process.exit(1);
}

export const client = new MongoClient(MONGO_URI);

let connected = null;

/** Connects once and reuses the same connection across requests. */
export async function connectToMongoDB() {
  if (connected) return connected;
  try {
    await client.connect();
    console.log("Connected to MongoDB.");
    connected = client.db("studioSpace");
    return connected;
  } catch (err) {
    console.error("[studiospace-server] Could not connect to MongoDB:", err.message);
    process.exit(1);
  }
}

/** The `studioSpace` database. Requires connectToMongoDB() first. */
export function getDb() {
  if (!connected) {
    throw new Error("Database not initialised — call connectToMongoDB() first.");
  }
  return connected;
}
