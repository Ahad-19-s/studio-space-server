
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGODB_URI);

// MongoDB Connection
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

// Database Connection
const mongoClient = await connectToMongoDB();

const db = mongoClient.db("studioSpace");

const userCollection = db.collection("users");
const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");

// 1. Get All Studios
app.get("/studios", async (req, res) => {
  try {
    const result = await studioCollection.find().toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to fetch studios!",
    });
  }
});

// 2. Get Featured Studios
app.get("/featured-studios", async (req, res) => {
  try {
    const result = await studioCollection
      .find()
      .sort({ rating: -1 })
      .limit(6)
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to fetch featured studios!",
    });
  }
});

// 3. Get Single Studio Details
app.get("/studio/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    const result = await studioCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!result) {
      return res.status(404).send({
        msg: "Studio not found!",
      });
    }

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to fetch studio details!",
    });
  }
});

// Home Route
app.get("/", (req, res) => {
  res.send({
    message: "StudioSpace server is running!",
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`StudioSpace server running on port ${PORT}`);
});

export default app;
