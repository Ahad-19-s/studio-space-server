import express from "express";
import cors from "cors";
import "dotenv/config";
import { ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import {
  connectToMongoDB,
  studioCollection,
  bookingCollection,
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



// Add a new studio (authenticated users only).
// The owner always comes from the verified session, never from the body.
app.post("/add-studio", requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    const user = req.user;

    if (!data.title || !data.category || !data.hourlyRate || !data.location) {
      return res.status(400).send({
        msg: "Please provide all required studio information!",
      });
    }

    const hourlyRate = Number(data.hourlyRate);
    const securityDeposit = Number(data.securityDeposit ?? 0);
    const maxCapacity = Number(data.maxCapacity ?? 1);

    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      return res.status(400).send({
        msg: "Hourly rate must be a positive number!",
      });
    }

    if (!Number.isFinite(securityDeposit) || securityDeposit < 0) {
      return res.status(400).send({
        msg: "Security deposit must be 0 or more!",
      });
    }

    if (!Number.isInteger(maxCapacity) || maxCapacity < 1) {
      return res.status(400).send({
        msg: "Max capacity must be a whole number of at least 1!",
      });
    }

    const studioData = {
      title: String(data.title),
      category: String(data.category),
      hourlyRate,
      securityDeposit,
      maxCapacity,
      location: String(data.location),
      image: data.image ? String(data.image) : "",
      amenities: Array.isArray(data.amenities) ? data.amenities.map(String) : [],
      overview: data.overview ? String(data.overview) : "",
      ownerName: user.name,
      ownerEmail: user.email,
      rating: 0,
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

// Get the logged in user's own listings.
app.get("/my-listings/:email", requireAuth, async (req, res) => {
  try {
    const { email } = req.params;

    // A user may only read their own listings.
    if (email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).send({
        msg: "You are not allowed to view these listings!",
      });
    }

    const result = await studioCollection
      .find({ ownerEmail: req.user.email })
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

// Update a studio (owner only).
app.patch("/studio/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    const studio = await studioCollection.findOne({ _id: new ObjectId(id) });

    if (!studio) {
      return res.status(404).send({
        msg: "Studio not found!",
      });
    }

    // Only the owner may update the studio.
    if (studio.ownerEmail.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).send({
        msg: "You are not allowed to update this studio!",
      });
    }

    const data = req.body || {};

    // Only these fields can be changed by a client.
    const allowedFields = [
      "title",
      "category",
      "hourlyRate",
      "securityDeposit",
      "maxCapacity",
      "location",
      "image",
      "amenities",
      "overview",
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates[field] = data[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({
        msg: "No update information provided!",
      });
    }

    // Validate numeric values when they are being updated.
    if (updates.hourlyRate !== undefined) {
      const hourlyRate = Number(updates.hourlyRate);
      if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
        return res.status(400).send({ msg: "Hourly rate must be a positive number!" });
      }
      updates.hourlyRate = hourlyRate;
    }

    if (updates.securityDeposit !== undefined) {
      const securityDeposit = Number(updates.securityDeposit);
      if (!Number.isFinite(securityDeposit) || securityDeposit < 0) {
        return res.status(400).send({ msg: "Security deposit must be 0 or more!" });
      }
      updates.securityDeposit = securityDeposit;
    }

    if (updates.maxCapacity !== undefined) {
      const maxCapacity = Number(updates.maxCapacity);
      if (!Number.isInteger(maxCapacity) || maxCapacity < 1) {
        return res.status(400).send({ msg: "Max capacity must be a whole number of at least 1!" });
      }
      updates.maxCapacity = maxCapacity;
    }

    updates.updatedAt = new Date();

    const result = await studioCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

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

// Delete a studio (owner only).
app.delete("/studio/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    const studio = await studioCollection.findOne({ _id: new ObjectId(id) });

    if (!studio) {
      return res.status(404).send({
        msg: "Studio not found!",
      });
    }

    // Only the owner may delete the studio.
    if (studio.ownerEmail.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).send({
        msg: "You are not allowed to delete this studio!",
      });
    }

    const result = await studioCollection.deleteOne({
      _id: new ObjectId(id),
    });

    res.send({
      success: true,
      msg: "Studio deleted successfully!",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to delete studio!",
    });
  }
});

// ---- Booking helpers ----
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// Converts "HH:MM" to minutes since midnight.
function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// Create a new booking (authenticated users only).
// Identity and price always come from the server, never from the client.
app.post("/bookings", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { studioId, bookingDate, startTime, endTime } = req.body || {};

    if (!studioId || !bookingDate || !startTime || !endTime) {
      return res.status(400).send({
        msg: "Studio ID, booking date, start time and end time are required!",
      });
    }

    if (!ObjectId.isValid(studioId)) {
      return res.status(400).send({
        msg: "Invalid studio ID!",
      });
    }

    if (!DATE_PATTERN.test(bookingDate) || Number.isNaN(Date.parse(bookingDate))) {
      return res.status(400).send({
        msg: "Booking date must be a valid date in YYYY-MM-DD format!",
      });
    }

    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
      return res.status(400).send({
        msg: "Start time and end time must use the HH:MM format!",
      });
    }

    const startMinutes = toMinutes(startTime);
    const endMinutes = toMinutes(endTime);

    if (endMinutes <= startMinutes) {
      return res.status(400).send({
        msg: "End time must be after the start time!",
      });
    }

    const studio = await studioCollection.findOne({
      _id: new ObjectId(studioId),
    });

    if (!studio) {
      return res.status(404).send({
        msg: "Studio not found!",
      });
    }

    const hourlyRate = Number(studio.hourlyRate);

    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      return res.status(400).send({
        msg: "This studio has an invalid hourly rate!",
      });
    }

    // Total price is calculated on the server from the studio's hourly rate.
    const totalHours = (endMinutes - startMinutes) / 60;
    const totalPrice = Math.round(hourlyRate * totalHours * 100) / 100;

    const booking = {
      studioId: new ObjectId(studioId),
      studioTitle: studio.title,
      userEmail: user.email,
      userName: user.name,
      bookingDate,
      startTime,
      endTime,
      totalPrice,
      status: "Pending",
      createdAt: new Date(),
    };

    const result = await bookingCollection.insertOne(booking);

    res.status(201).send({
      success: true,
      msg: "Booking created successfully!",
      insertedId: result.insertedId,
      booking: { ...booking, _id: result.insertedId },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to create booking!",
    });
  }
});

// Get the logged in user's own bookings.
app.get("/my-bookings/:email", requireAuth, async (req, res) => {
  try {
    const { email } = req.params;

    // A user may only read their own bookings.
    if (email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).send({
        msg: "You are not allowed to view these bookings!",
      });
    }

    const result = await bookingCollection
      .find({ userEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to fetch your bookings!",
    });
  }
});

// Cancel a booking (owner of the booking, only when still Pending).
app.patch("/bookings/:id/cancel", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        msg: "Invalid booking ID!",
      });
    }

    const booking = await bookingCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return res.status(404).send({
        msg: "Booking not found!",
      });
    }

    // Only the user who made the booking may cancel it.
    if (booking.userEmail.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).send({
        msg: "You are not allowed to cancel this booking!",
      });
    }

    if (booking.status !== "Pending") {
      return res.status(409).send({
        msg: "Only pending bookings can be cancelled!",
      });
    }

    const result = await bookingCollection.updateOne(
      { _id: new ObjectId(id), status: "Pending" },
      { $set: { status: "Cancelled" } }
    );

    if (result.matchedCount === 0) {
      return res.status(409).send({
        msg: "Only pending bookings can be cancelled!",
      });
    }

    res.send({
      success: true,
      msg: "Booking cancelled successfully!",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      msg: "Failed to cancel booking!",
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
