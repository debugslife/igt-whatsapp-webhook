const express = require("express");
const { MongoClient } = require("mongodb");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ENV
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WA_TOKEN = process.env.PERMANENT_TOKEN;
const SHEET_ID = "1ZZFQes5R3p0sbMXJpRlIGJxQePzEp4AzpbrHpvUQpaI";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

let db;

// Approval keywords
const APPROVE_WORDS = ["approve", "approved", "confirmed", "text"];

function isApprovalMessage(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return APPROVE_WORDS.some(word => lower.includes(word));
}

// UAE time formatter
function toUaeString(date) {
    if (!date) return "";
    return new Date(date).toLocaleString("en-US", {
        timeZone: "Asia/Dubai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

// Google Sheets append
async function appendToSheet(row) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });

        const sheets = google.sheets({ version: "v4", auth });

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "Sheet1!A1",
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [row]
            }
        });
    } catch (err) {
        console.error("Google Sheets append error:", err.message || err);
    }
}

// Fetch media URL from WhatsApp
async function getMediaUrl(mediaId) {
    try {
        const response = await fetch(
            `https://graph.facebook.com/v20.0/${mediaId}`,
            {
                headers: {
                    Authorization: `Bearer ${WA_TOKEN}`
                }
            }
        );

        const json = await response.json();
        return json.url || null;
    } catch (err) {
        console.error("Error fetching media URL:", err);
        return null;
    }
}

// MongoDB
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
        const waTimestampMs = message.timestamp
            ? Number(message.timestamp) * 1000
            : Date.now();
        const receivedAt = new Date(waTimestampMs);

        // MEDIA DETECTION FOR THIS MESSAGE (replier or original if not reply)
        let mediaType = null;
        let mediaId = null;
        let mimeType = null;
        let caption = null;

        switch (message.type) {
            case "image":
                mediaType = "image";
                mediaId = message.image?.id;
                mimeType = message.image?.mime_type;
                caption = message.image?.caption || null;
                break;
            case "video":
                mediaType = "video";
                mediaId = message.video?.id;
                mimeType = message.video?.mime_type;
                caption = message.video?.caption || null;
                break;
            case "audio":
                mediaType = "audio";
                mediaId = message.audio?.id;
                mimeType = message.audio?.mime_type;
                break;
            case "document":
                mediaType = "document";
                mediaId = message.document?.id;
                mimeType = message.document?.mime_type;
                caption = message.document?.filename || null;
                break;
            case "sticker":
                mediaType = "sticker";
                mediaId = message.sticker?.id;
                mimeType = message.sticker?.mime_type;
                break;
            case "voice":
                mediaType = "voice";
                mediaId = message.voice?.id;
                mimeType = message.voice?.mime_type;
                break;
            case "location":
                mediaType = "location";
                break;
            case "contacts":
                mediaType = "contacts";
                break;
        }

        let mediaUrl = null;
        if (mediaId) {
            mediaUrl = await getMediaUrl(mediaId);
        }

        // Save every message to MongoDB
        await db.collection("messages").insertOne({
            received_at: receivedAt,
            message_id: messageId,
            from: from,
            text: text,
            reply_to: replyToId,
            media_type: mediaType,
            media_id: mediaId,
            media_url: mediaUrl,
            mime_type: mimeType,
            caption: caption,
            raw: data
        });

        console.log("Saved message:", { text, mediaType, mediaId, mediaUrl });

        // Build Google Sheets row (one sheet, your order)
        const isReply = !!replyToId;
        let originalMessage = null;

        let originalTsUae = "";
        let originalSender = "";
        let originalText = "";
        let originalMediaType = "";
        let originalMediaUrl = "";

        let replyTsUae = "";
        let replierName = "";
        let replierMessage = "";
        let replierMediaType = "";
        let replierMediaUrl = "";

        if (isReply) {
            // Find original message
            originalMessage = await db.collection("messages").findOne({
                message_id: replyToId
            });

            if (originalMessage) {
                originalTsUae = toUaeString(originalMessage.received_at);
                originalSender = originalMessage.from || "";
                originalText = originalMessage.text || "";
                originalMediaType = originalMessage.media_type || "";
                originalMediaUrl = originalMessage.media_url || "";
            }

            replyTsUae = toUaeString(receivedAt);
            replierName = from;
            replierMessage = text || "";
            replierMediaType = mediaType || "";
            replierMediaUrl = mediaUrl || "";
        } else {
            // Not a reply → this message is the original
            originalTsUae = toUaeString(receivedAt);
            originalSender = from;
            originalText = text || "";
            originalMediaType = mediaType || "";
            originalMediaUrl = mediaUrl || "";
        }

        const category = isApprovalMessage(text) ? "Approved" : "Message";

        // Final column order:
        // 1. MessageID (original if exists, else this message)
        // 2. Category
        // 3. Original timestamp (UAE)
        // 4. Original sender
        // 5. Original message text
        // 6. Original media type
        // 7. Original media URL
        // 8. Reply message ID
        // 9. Reply timestamp (UAE)
        // 10. Replier name
        // 11. Replier message text
        // 12. Replier media type
        // 13. Replier media URL
        const sheetRow = [
            originalMessage?.message_id || messageId,
            category,
            originalTsUae,
            originalSender,
            originalText,
            originalMediaType,
            originalMediaUrl,
            isReply ? messageId : "",
            replyTsUae,
            replierName,
            replierMessage,
            replierMediaType,
            replierMediaUrl
        ];

        await appendToSheet(sheetRow);

        // Optional approvals collection
        if (isApprovalMessage(text)) {
            let originalMediaUrlForApproval = null;
            if (originalMessage?.media_id) {
                originalMediaUrlForApproval =
                    originalMessage.media_url ||
                    (await getMediaUrl(originalMessage.media_id));
            }

            await db.collection("approvals").insertOne({
                approval_timestamp: receivedAt,
                approver: from,
                approval_text: text,
                approval_message_id: messageId,

                original_message_id: replyToId || null,
                original_sender: originalMessage?.from || null,
                original_text: originalMessage?.text || null,
                original_timestamp: originalMessage?.received_at || null,

                original_media_id: originalMessage?.media_id || null,
                original_media_url: originalMediaUrlForApproval,
                original_media_type: originalMessage?.media_type || null,

                raw: data
            });

            console.log("Approval saved with linked original message");
        }

    } catch (err) {
        console.error("Webhook Error:", err);
    }

    res.sendStatus(200);
});

// Start server
app.listen(process.env.PORT || 3000, () =>
    console.log("Webhook running")
);
