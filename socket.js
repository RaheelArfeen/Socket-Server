import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import { ObjectId } from "mongodb";
import dbConnect from "./db.js";

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

/**
 * Fetches the recipient's current unread count and the last message preview for a chat.
 * @param {string} chatId - The ID of the chat.
 * @param {string} recipientEmail - The email of the recipient participant.
 * @returns {Promise<{unreadCount: number, lastMessagePreview: string, lastMessageAt: string}>}
 */
async function fetchRecipientUnreadCount(chatId, recipientEmail) {
    try {
        const chatsCollection = await dbConnect("chats");

        // Find chat by ID
        const chat = await chatsCollection.findOne(
            { _id: new ObjectId(chatId) }
        );

        if (!chat) return { unreadCount: 0, lastMessagePreview: "Chat not found", lastMessageAt: new Date().toISOString() };

        // Find recipient participant data
        const recipientParticipant = chat.participants?.find(p => p.email === recipientEmail);

        // Get the actual last message from the messages array
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
        const finalMsg = { ...savedMsg, optimisticId };

        // 1. Emit the new message to the chat room (for users currently viewing the chat)
        io.to(chatId).emit("newMessage", finalMsg);

        const senderEmail = savedMsg?.sender?.email;
        const recipientEmail = savedMsg?.receiver?.email;

        if (!senderEmail || !recipientEmail) {
            console.warn(`[WARN] Missing sender/receiver data in newMessage for chat ${chatId}`);
            return res.status(200).send({ success: true, warning: "Missing participant info" });
        }

        console.log(`[API_PUSH] New Message sent to room ${chatId} from ${senderEmail}`);

        // 🔥 CRITICAL UPDATE FOR RED DOT STATUS (UNREAD COUNT)
        try {
            const chatsCollection = await dbConnect("chats");

            // Optimistically increment the recipient's unreadCount by 1 in the DB
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": recipientEmail },
                { $inc: { "participants.$[recipient].unreadCount": 1 } },
                { arrayFilters: [{ "recipient.email": recipientEmail }] }
            );
            console.log(`[DB_UPDATE] Incremented unreadCount for ${recipientEmail} in chat ${chatId}`);

        } catch (err) {
            console.error("Failed to increment unreadCount in socket server:", err.message);
        }
        // 🔥 END CRITICAL UPDATE

        // 2. Check if recipient is online (but not necessarily in the chat room)
        const recipientSocketId = onlineUsers[recipientEmail];

        if (recipientSocketId) {

            // 3. Fetch the new unread count (which is now updated in the DB) and last message preview
            const updateData = await fetchRecipientUnreadCount(chatId, recipientEmail);

            // 4. Emit a dedicated event to the recipient's socket for conversation list update
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
        console.log(`[API_PUSH] Message reacted in room ${chatId} on ${messageId}`);

    } else if (action === "messageEdit") {
        const { messageId, newText } = data;
        io.to(chatId).emit("messageEdit", chatId, messageId, newText);
        console.log(`[API_PUSH] Message edited in room ${chatId} on ${messageId}`);

    } else if (action === "messageDelete") {
        const { messageId, deletedBy } = data;
        io.to(chatId).emit("messageDelete", chatId, messageId, deletedBy);
        console.log(`[API_PUSH] Message deleted in room ${chatId} on ${messageId}`);

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
            console.log(`[STATUS] User ${offlineEmail} went offline.`);
        }
        console.log("[SOCKET] User disconnected:", socket.id);
    });

    // Join chat room
    socket.on("joinChat", async (chatId, lastMessageId = null) => {
        if (!chatId) {
            console.warn("[WARN] joinChat called with invalid chatId:", chatId);
            return;
        }
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
    socket.on("messageSeen", async (chatId, messageId, viewerEmail) => {
        if (!chatId || !messageId || !viewerEmail) {
            console.warn("[WARN] Invalid messageSeen payload:", { chatId, messageId, viewerEmail });
            return;
        }

        io.to(chatId).emit("messageSeenUpdate", chatId, messageId, viewerEmail);
        console.log(`[SEEN] Message ${messageId} seen in room ${chatId} by ${viewerEmail}`);

        // Fallback DB update (in case frontend PATCH fails or for safety)
        try {
            const chatsCollection = await dbConnect("chats");

            if (!ObjectId.isValid(chatId) || !ObjectId.isValid(messageId)) {
                console.warn("[WARN] Invalid ObjectId detected:", { chatId, messageId });
                return;
            }

            // 1. Mark individual message as seen
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId) },
                { $set: { "messages.$[msg].isSeen": true } },
                { arrayFilters: [{ "msg._id": new ObjectId(messageId) }] }
            );

            // 2. Reset the viewer's unreadCount to 0 (since they explicitly marked a message seen)
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": viewerEmail },
                { $set: { "participants.$[viewer].unreadCount": 0 } },
                { arrayFilters: [{ "viewer.email": viewerEmail }] }
            );

        } catch (err) {
            console.error("Failed to update isSeen in DB (socket fallback):", err.message);
        }
    });

    // ------------------- Conversation Seen -------------------
    socket.on("conversationSeen", async (chatId, viewerEmail) => {
        if (!chatId || !viewerEmail) return;

        // Emit to the sender (who is in the same room)
        socket.to(chatId).emit("conversationSeen", chatId, viewerEmail);
        console.log(`[CONV_SEEN] All messages in ${chatId} seen by ${viewerEmail}`);

        // Reset unreadCount on the backend immediately
        try {
            const chatsCollection = await dbConnect("chats");
            const resetUnreadResult = await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": viewerEmail },
                { $set: { "participants.$[viewer].unreadCount": 0 } },
                { arrayFilters: [{ "viewer.email": viewerEmail }] }
            );

            if (resetUnreadResult.modifiedCount > 0) {
                console.log(`[DB] Unread count reset for ${viewerEmail} in chat ${chatId}`);
            }

        } catch (err) {
            console.error("Failed to reset unreadCount on conversationSeen:", err.message);
        }
    });
});

server.listen(3001, () => console.log("✅ Socket server running on port 3001"));