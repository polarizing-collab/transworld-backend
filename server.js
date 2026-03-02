import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import winston from "winston";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== WINSTON LOGGER =====
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "server.log" }),
  ],
});

// ===== FIREBASE ADMIN INIT =====
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  logger.error("❌ FIREBASE_SERVICE_ACCOUNT env variable missing!");
  process.exit(1);
}

// Parse service account from env variable (stringified JSON)
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  logger.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON: " + err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ===== SECURITY MIDDLEWARE =====
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(mongoSanitize());
app.use(hpp());

// ===== CORS =====
const allowedOrigins = [
  "http://localhost:3000",
  "https://transworld-67f4a.firebaseapp.com",
];
app.use(
  cors({
    origin: (origin, callback) =>
      !origin || allowedOrigins.includes(origin)
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS")),
  })
);

// ===== RATE LIMIT =====
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
      status: 429,
      message: "Too many requests, please try again later.",
    },
  })
);

// ===== MORGAN → WINSTON =====
app.use(morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, "../public")));

// ===== FIREBASE CONFIG ROUTE =====
app.get("/config", (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  });
});

// ===== VERIFY TOKEN =====
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error("Token verify failed: " + err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ===== IN-MEMORY STORAGE =====
const drivers = [];
const rides = [];

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/Welcome.html"));
});

app.post("/driver/status", verifyToken, (req, res) => {
  const { status, lat, lng } = req.body;
  if (!status) return res.status(400).json({ error: "Status required" });

  const idx = drivers.findIndex((d) => d.uid === req.user.uid);
  const driverObj = {
    uid: req.user.uid,
    email: req.user.email,
    status,
    lat,
    lng,
    updatedAt: new Date(),
  };
  if (idx >= 0) drivers[idx] = driverObj;
  else drivers.push(driverObj);

  res.json({ message: "Status updated", driver: driverObj });
});

app.get("/drivers", verifyToken, (req, res) => {
  res.json(drivers.filter((d) => d.status === "online"));
});

app.post("/ride", verifyToken, (req, res) => {
  const { phone, area, lat, lng } = req.body;
  if (!phone || !area)
    return res.status(400).json({ error: "Missing phone or area" });

  const ride = {
    id: Date.now().toString(),
    rider: req.user.email,
    phone,
    area,
    lat,
    lng,
    status: "pending",
    requestedAt: new Date(),
  };
  rides.push(ride);

  res.json({ message: "Ride requested successfully", ride });
});

app.get("/rides", verifyToken, (req, res) => {
  res.json(rides.filter((r) => r.status === "pending"));
});

app.post("/ride/accept", verifyToken, (req, res) => {
  const { riderEmail } = req.body;
  const ride = rides.find(
    (r) => r.rider === riderEmail && r.status === "pending"
  );
  if (!ride)
    return res.status(404).json({ error: "Ride not found or already accepted" });

  ride.status = "accepted";
  ride.driver = req.user.email;
  ride.acceptedAt = new Date();

  res.json({ message: `Ride accepted! Rider: ${ride.rider}` });
});

// ===== 404 & ERROR =====
app.use((req, res) => res.status(404).json({ error: "Page Not Found" }));
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
