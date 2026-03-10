const express = require("express");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "MYTOKEN123";

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

app.post("/webhook", (req, res) => {
    console.log("Incoming WhatsApp Message:");
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(3000, () => console.log("Webhook running on port 3000"));