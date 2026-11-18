import { MongoClient } from "mongodb";

// One shared MongoDB client for the whole server.
const client = new MongoClient(process.env.MONGODB_URI);

// Connect to MongoDB (called once when the server starts).
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

// Application database.
export const db = client.db("studioSpace");

// Collections used by the application.
// The "users" collection is shared with BetterAuth (see auth.js).
export const userCollection = db.collection("users");
export const studioCollection = db.collection("studios");
export const bookingCollection = db.collection("bookings");

// Internal lock collection used to prevent double bookings.
export const bookingLockCollection = db.collection("bookingLocks");

export { client };
