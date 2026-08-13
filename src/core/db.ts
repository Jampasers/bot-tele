import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Singleton connection state.
// Mongoose itself already manages one internal connection pool, but this
// wrapper makes the startup sequence explicit and gives us a single place
// to configure, log, and close the connection.
// ---------------------------------------------------------------------------

let isConnected = false;

/**
 * Establishes a connection to MongoDB using the MONGODB_URI env variable.
 * Safe to call multiple times — subsequent calls are no-ops if already connected.
 *
 * @throws If MONGODB_URI is not set or if the connection attempt fails.
 */
export async function connectDatabase(): Promise<void> {
  if (isConnected) {
    console.log("ℹ️   Database already connected, reusing existing connection.");
    return;
  }

  const { MONGODB_URI, DATABASE_NAME } = process.env;

  if (!MONGODB_URI || MONGODB_URI.trim() === "") {
    throw new Error(
      "MONGODB_URI is not set.\n" +
        "    Add it to your .env file: MONGODB_URI=mongodb://localhost:27017/grammy-bot"
    );
  }

  // Disable Mongoose's deprecated strictQuery default warning.
  mongoose.set("strictQuery", true);

  // Forward Mongoose connection events to the console so ops teams
  // can monitor connectivity without adding extra tooling.
  mongoose.connection.on("connected", () =>
    console.log("✅  MongoDB connected successfully.")
  );
  mongoose.connection.on("disconnected", () =>
    console.warn("⚠️   MongoDB disconnected.")
  );
  mongoose.connection.on("error", (err: Error) =>
    console.error("❌  MongoDB connection error:", err)
  );

  await mongoose.connect(MONGODB_URI, {
    // Let the driver pick the best server automatically.
    serverSelectionTimeoutMS: 5_000, // fail fast if the server is unreachable
    socketTimeoutMS: 45_000,
    family: 4,
    dbName: DATABASE_NAME || "danka-telegram", // default database name for this app
  });

  isConnected = true;
}

/**
 * Gracefully closes the Mongoose connection.
 * Call this before process.exit() to flush pending operations.
 */
export async function disconnectDatabase(): Promise<void> {
  if (!isConnected) return;
  await mongoose.connection.close();
  isConnected = false;
  console.log("🔌  MongoDB connection closed.");
}
