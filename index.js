const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

let db;

// Connect to MongoDB
MongoClient.connect(MONGO_URI, {
    tls: true,
    tlsAllowInvalidCertificates: false,
    serverSelectionTimeoutMS: 5000
})
    .then(client => {
        db = client.db("whatsapp_logger");
        console.log("Connected to MongoDB");
    })
    .catch(err => console.error("MongoDB connection error:", err));

// Verification endpoint
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Receive messages
app.post("/webhook", async (req, res) => {
    try {
        const data = req.body;

        await db.collection("messages").insertOne({
            received_at: new Date(),
            data: data
        });

        console.log("Saved message to DB");
    } catch (err) {
        console.error("DB Error:", err);
    }

    res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () =>
    console.log("Webhook running")
);