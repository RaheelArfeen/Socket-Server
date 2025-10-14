import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import { ObjectId } from "mongodb";
import dbConnect from "./db.js"; // Assuming this connects to your Mongo DB

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
    },
});

app.use(bodyParser.json());

if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI must be defined in your .env file");
}

let onlineUsers = {};

// ------------------- Helper Function -------------------

/**
 * Fetches the recipient's current unread count and the last message preview for a chat.
 * @param {string} chatId - The ID of the chat.
 * @param {string} recipientEmail - The email of the recipient participant.
 * @returns {Promise<{unreadCount: number, lastMessagePreview: string, lastMessageAt: string}>}
 */
async function fetchRecipientUnreadCount(chatId, recipientEmail) {
    try {
        const chatsCollection = await dbConnect("chats");

        const chat = await chatsCollection.findOne(
            { _id: new ObjectId(chatId) }
        );

        if (!chat) return { unreadCount: 0, lastMessagePreview: "Chat not found", lastMessageAt: new Date().toISOString() };

        const recipientParticipant = chat.participants?.find(p => p.email === recipientEmail);
        const lastMessage = chat.messages?.[chat.messages.length - 1];

        return {
            unreadCount: recipientParticipant?.unreadCount || 0,
            lastMessagePreview: lastMessage?.text || "New message",
            lastMessageAt: lastMessage?.createdAt || new Date().toISOString()
        };

    } catch (err) {
        console.error("Failed to fetch unread count in socket server:", err.message);
        return { unreadCount: 0, lastMessagePreview: "Error fetching preview", lastMessageAt: new Date().toISOString() };
    }
}


// ------------------- API to push saved messages/events -------------------
app.post("/api/socket/emit", async (req, res) => {
    const { chatId, action, data } = req.body;

    if (!chatId || !action || !data) {
        return res.status(400).send({ error: "Missing required fields" });
    }

    if (action === "newMessage") {
        const { savedMsg, optimisticId } = data;

        // ⭐ CRITICAL FIX: Ensure the payload for the socket includes the optimisticId
        // so the sender's frontend can replace the temporary message.
        const finalMsg = { ...savedMsg, optimisticId };

        const senderEmail = savedMsg?.sender?.email;
        const recipientEmail = savedMsg?.receiver?.email;

        if (!senderEmail || !recipientEmail) {
            console.warn(`[WARN] Missing sender/receiver data in newMessage for chat ${chatId}`);
            return res.status(200).send({ success: true, warning: "Missing participant info" });
        }

        // 1. Emit the new message to the chat room (for users currently viewing the chat)
        io.to(chatId).emit("newMessage", finalMsg);
        console.log(`[API_PUSH] New Message emitted to room ${chatId} from ${senderEmail}`);


        // 2. Increment the recipient's unreadCount by 1 in the DB
        try {
            const chatsCollection = await dbConnect("chats");
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": recipientEmail },
                { $inc: { "participants.$[recipient].unreadCount": 1 } },
                { arrayFilters: [{ "recipient.email": recipientEmail }] }
            );

        } catch (err) {
            console.error("Failed to increment unreadCount in socket server:", err.message);
        }


        // 3. Check if recipient is online
        const recipientSocketId = onlineUsers[recipientEmail];

        if (recipientSocketId) {

            // 4. Fetch the new conversation list update data
            const updateData = await fetchRecipientUnreadCount(chatId, recipientEmail);

            // 5. Emit a dedicated event to the recipient's socket for conversation list update
            io.to(recipientSocketId).emit("conversationUpdate", {
                chatId,
                ...updateData,
                lastMessageSenderEmail: senderEmail
            });
            console.log(`[PUSH_CONV] Emitted update to recipient ${recipientEmail} for chat ${chatId}`);

        }

    } else if (action === "messageReact") {
        const { messageId, reactions } = data;
        io.to(chatId).emit("messageReact", chatId, messageId, reactions);

    } else if (action === "messageEdit") {
        const { messageId, newText } = data;
        io.to(chatId).emit("messageEdit", chatId, messageId, newText);

    } else if (action === "messageDelete") {
        const { messageId, deletedBy } = data;
        io.to(chatId).emit("messageDelete", chatId, messageId, deletedBy);
    } else {
        return res.status(400).send({ error: `Unknown action: ${action}` });
    }

    return res.status(200).send({ success: true });
});

// ------------------- Socket.io Events -------------------
io.on("connection", (socket) => {
    console.log("[SOCKET] User connected:", socket.id);

    // Track online users
    socket.on("userOnline", (email) => {
        if (!email) return;
        onlineUsers[email] = socket.id;
        io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
        console.log(`[STATUS] User ${email} is online.`);
    });

    socket.on("disconnect", () => {
        const offlineEmail = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
        if (offlineEmail) {
            delete onlineUsers[offlineEmail];
            io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
        }
        console.log("[SOCKET] User disconnected:", socket.id);
    });

    // Room management
    socket.on("joinChat", (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        console.log(`[ROOM] ${socket.id} joined room: ${chatId}`);
    });

    socket.on("leaveChat", (chatId) => {
        if (!chatId) return;
        socket.leave(chatId);
        console.log(`[ROOM] ${socket.id} left room: ${chatId}`);
    });

    // Typing indicators
    socket.on("typing", (chatId, senderEmail) => {
        if (!chatId || !senderEmail) return;
        socket.to(chatId).emit("typing", chatId, senderEmail);
    });

    socket.on("stopTyping", (chatId, senderEmail) => {
        if (!chatId || !senderEmail) return;
        socket.to(chatId).emit("stopTyping", chatId, senderEmail);
    });

    // ------------------- Message Seen -------------------
    // This is for individual message read receipts (the tick marks)
    socket.on("messageSeen", (chatId, messageId, viewerEmail) => {
        if (!chatId || !messageId || !viewerEmail) return;

        // ONLY EMIT THE REAL-TIME EVENT for the sender's read receipt
        io.to(chatId).emit("messageSeenUpdate", chatId, messageId, viewerEmail);
    });

    // ------------------- Conversation Seen (Mark all as read) -------------------
    socket.on("conversationSeen", async (chatId, viewerEmail) => {
        if (!chatId || !viewerEmail) return;

        // 1. Emit to the sender (who is in the same room) to mark all their sent messages as seen
        socket.to(chatId).emit("conversationSeen", chatId, viewerEmail);

        // 2. Reset unreadCount on the backend immediately
        try {
            const chatsCollection = await dbConnect("chats");
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": viewerEmail },
                { $set: { "participants.$[viewer].unreadCount": 0 } },
                { arrayFilters: [{ "viewer.email": viewerEmail }] }
            );

        } catch (err) {
            console.error("Failed to reset unreadCount on conversationSeen:", err.message);
        }
    });
});

server.listen(3001, () => console.log("✅ Socket server running on port 3001"));

// Root route to verify server is running
app.get("/", (req, res) => {
    res.send("✅ Socket server is running on port 3001");
});
