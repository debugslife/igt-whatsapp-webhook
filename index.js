const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

// Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGO_URI = process.env.MONGO_URI;

let db;

// Approval keywords
const APPROVE_WORDS = ["approve", "approved", "confirmed", "text"];

function isApprovalMessage(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return APPROVE_WORDS.some(word => lower.includes(word));
}

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


// Webhook verification
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


// Webhook receiver
app.post("/webhook", async (req, res) => {
    try {
        const data = req.body;

        const entry = data.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        if (!message) {
            return res.sendStatus(200);
        }

        const text = message.text?.body || null;
        const messageId = message.id;
        const from = message.from;
        const replyToId = message.context?.id || null;

        // Save every message
        await db.collection("messages").insertOne({
            received_at: new Date(),
            message_id: messageId,
            from: from,
            text: text,
            reply_to: replyToId,
            raw: data
        });

        console.log("Saved message to DB:", text);

        // Detect approval
        if (isApprovalMessage(text)) {
            console.log("Approval detected:", text);

            let originalMessage = null;

            // If this approval is a reply, find the original message
            if (replyToId) {
                originalMessage = await db.collection("messages").findOne({
                    message_id: replyToId
                });

                if (originalMessage) {
                    console.log("Matched approval to original message");
                } else {
                    console.log("Approval detected but no matching original message found");
                }
            }

            // Save approval record
            await db.collection("approvals").insertOne({
                approval_timestamp: new Date(),
                approver: from,
                approval_text: text,
                approval_message_id: messageId,

                original_message_id: replyToId || null,
                original_sender: originalMessage?.from || null,
                original_text: originalMessage?.text || null,
                original_timestamp: originalMessage?.received_at || null,

                raw: data
            });
        }

    } catch (err) {
        console.error("DB Error:", err);
    }

    res.sendStatus(200);
});


// Start server
app.listen(process.env.PORT || 3000, () =>
    console.log("Webhook running")
);
