
import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();

const PORT = process.env.PORT || 8000;

// Middleware
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());

// Home route
app.get("/", (req, res) => {
  res.send({
    message: "StudioSpace server is running!",
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`StudioSpace server running on port ${PORT}`);
});

export default app;
