import express from "express";
import cors from "cors";
import "dotenv/config";
import { ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import {
  connectToMongoDB,
  studioCollection,
} from "./db.js";

// Kept for backwards compatibility (the connection now lives in db.js).
export { connectToMongoDB };

const app = express();
const PORT = process.env.PORT || 8000;

// CORS: allow the frontend to call this API with cookies.
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// BetterAuth routes: /api/auth/sign-up, /api/auth/sign-in,
// /api/auth/sign-out, /api/auth/get-session, /api/auth/token, ...
// Mounted before express.json() so BetterAuth can read the request body.
app.use("/api/auth", toNodeHandler(auth));

app.use(express.json());

// Database Connection
await connectToMongoDB();

// Returns the logged in user from the session cookie, or null.
// The identity always comes from the verified session, never from
// an email address sent in the request body.
export async function getAuthenticatedUser(req) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return session?.user || null;
}

// Protects private routes: 401 when there is no valid session.
export async function requireAuth(req, res, next) {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).send({
        msg: "Unauthorized! Please log in first.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Authentication check failed!",
    });
  }
}

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



app.post("/add-studio", async (req, res) => {
  try {
    const data = req.body;

    if (
      !data.title ||
      !data.category ||
      !data.hourlyRate ||
      !data.location ||
      !data.ownerEmail
    ) {
      return res.status(400).send({
        msg: "Please provide all required studio information!",
      });
    }

    const studioData = {
      ...data,
      hourlyRate: Number(data.hourlyRate),
      securityDeposit: Number(data.securityDeposit || 0),
      maxCapacity: Number(data.maxCapacity || 1),
      rating: Number(data.rating || 0),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await studioCollection.insertOne(studioData);

    res.status(201).send({
      success: true,
      msg: "Studio added successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to add studio!",
    });
  }
});

app.get("/my-listings/:email", async (req, res) => {
  try {
    const { email } = req.params;

    const result = await studioCollection
      .find({ ownerEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to fetch your studio listings!",
    });
  }
});

app.patch("/studio/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { ownerEmail, _id, ...data } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    if (!ownerEmail) {
      return res.status(400).send({
        msg: "Owner email is required!",
      });
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).send({
        msg: "No update information provided!",
      });
    }

    const result = await studioCollection.updateOne(
      {
        _id: new ObjectId(id),
        ownerEmail: ownerEmail,
      },
      {
        $set: {
          ...data,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        msg: "Studio not found or not owned by this user!",
      });
    }

    res.send({
      success: true,
      msg: "Studio updated successfully!",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to update studio!",
    });
  }
});

app.delete("/studio/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { ownerEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    if (!ownerEmail) {
      return res.status(400).send({
        msg: "Owner email is required!",
      });
    }

    const result = await studioCollection.deleteOne({
      _id: new ObjectId(id),
      ownerEmail: ownerEmail,
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        msg: "Studio not found or not owned by this user!",
      });
    }

    res.send({
      success: true,
      msg: "Studio deleted successfully!",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to delete studio!",
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
