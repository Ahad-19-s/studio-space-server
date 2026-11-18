
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGODB_URI);

// MongoDB connection
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

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());

// Connect Database
const mongoClient = await connectToMongoDB();

const db = mongoClient.db("studioSpace");

const userCollection = db.collection("users");
const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");

// Home route
app.get("/", (req, res) => {
  res.send({
    message: "StudioSpace server is running!",
  });
});

app.listen(PORT, () => {
  console.log(`StudioSpace server running on port ${PORT}`);
});

export default app;
