import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import { ObjectId } from "mongodb";
import dbConnect from "./db.js"; // Your DB connection utility

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }, // Allows all origins for CORS
    pingInterval: 25000, 
    pingTimeout: 60000,
});

app.use(bodyParser.json());

if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI must be defined in your .env file");
}

let onlineUsers = {};

// ... (fetchRecipientUnreadCount function remains the same) ...

async function fetchRecipientUnreadCount(chatId, recipientEmail) {
    try {
        const chatsCollection = await dbConnect("chats");

        const chat = await chatsCollection.findOne(
            { _id: new ObjectId(chatId) }
        );
        
        console.log(`[DB] Fetched chat ${chatId} for recipient ${recipientEmail}`);

        if (!chat) return { unreadCount: 0, lastMessagePreview: "Chat not found", lastMessageAt: new Date().toISOString() };

        const recipientParticipant = chat.participants?.find(p => p.email === recipientEmail);
        const lastMessage = chat.messages?.[chat.messages.length - 1];

        return {
            unreadCount: recipientParticipant?.unreadCount || 0,
            lastMessagePreview: lastMessage?.text || "New message",
            lastMessageAt: lastMessage?.createdAt || new Date().toISOString()
        };

    } catch (err) {
        console.error("[ERROR] Failed to fetch unread count in socket server:", err.message);
        return { unreadCount: 0, lastMessagePreview: "Error fetching preview", lastMessageAt: new Date().toISOString() };
    }
}

// -----------------------------------------------------
// Primary HTTP POST Endpoint for Emitting Events
// -----------------------------------------------------

app.post("/api/socket/emit", async (req, res) => {
    const { chatId, action, data } = req.body;

    // CRITICAL LOGGING: If this appears in Render logs, your client HTTP POST is working.
    console.log(`[API_CALL] Received action: ${action} for chatId: ${chatId}`);

    if (!chatId || !action || !data) {
        console.error("[API_ERROR] Missing required fields in API call.");
        return res.status(400).send({ error: "Missing required fields" });
    }

    if (action === "newMessage") {
        const { savedMsg, optimisticId } = data;

        const finalMsg = { ...savedMsg, optimisticId };

        const senderEmail = savedMsg?.sender?.email;
        const recipientEmail = savedMsg?.receiver?.email;

        if (!senderEmail || !recipientEmail) {
            console.warn("[API_WARN] Missing sender or recipient email for newMessage.");
            return res.status(200).send({ success: true, warning: "Missing participant info" });
        }

        // CRITICAL: The message is emitted to the room.
        console.log(`[SOCKET_EMIT] Attempting to emit 'newMessage' to room: ${chatId}`);
        io.to(chatId).emit("newMessage", finalMsg);
        console.log(`[SOCKET_EMIT] 'newMessage' emitted successfully.`);


        try {
            const chatsCollection = await dbConnect("chats");
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": recipientEmail },
                { $inc: { "participants.$[recipient].unreadCount": 1 } },
                { arrayFilters: [{ "recipient.email": recipientEmail }] }
            );
            console.log(`[DB] Incremented unread count for recipient: ${recipientEmail}`);

        } catch (err) {
            console.error("[DB_ERROR] Failed to increment unreadCount in socket server:", err.message);
        }

        const recipientSocketId = onlineUsers[recipientEmail];
        
        if (recipientSocketId) {
            console.log(`[STATUS] Recipient ${recipientEmail} is ONLINE. Socket ID: ${recipientSocketId}`);

            const updateData = await fetchRecipientUnreadCount(chatId, recipientEmail);

            io.to(recipientSocketId).emit("conversationUpdate", {
                chatId,
                ...updateData,
                lastMessageSenderEmail: senderEmail
            });
            console.log(`[SOCKET_EMIT] Emitted 'conversationUpdate' to recipient: ${recipientEmail}`);
        } else {
            console.log(`[STATUS] Recipient ${recipientEmail} is OFFLINE. 'conversationUpdate' skipped.`);
        }

    } else if (action === "messageReact") {
        const { messageId, reactions } = data;
        io.to(chatId).emit("messageReact", chatId, messageId, reactions);
        console.log(`[SOCKET_EMIT] Emitted 'messageReact' to room: ${chatId}`);

    } else if (action === "messageEdit") {
        const { messageId, newText } = data;
        io.to(chatId).emit("messageEdit", chatId, messageId, newText);
        console.log(`[SOCKET_EMIT] Emitted 'messageEdit' to room: ${chatId}`);

    } else if (action === "messageDelete") {
        const { messageId, deletedBy } = data;
        io.to(chatId).emit("messageDelete", chatId, messageId, deletedBy);
        console.log(`[SOCKET_EMIT] Emitted 'messageDelete' to room: ${chatId}`);
    } else {
        console.error(`[API_ERROR] Unknown action received: ${action}`);
        return res.status(400).send({ error: `Unknown action: ${action}` });
    }

    return res.status(200).send({ success: true });
});

// -----------------------------------------------------
// Socket.IO Connection Handlers
// -----------------------------------------------------

io.on("connection", (socket) => {
    console.log(`[CONNECT] A user connected. Socket ID: ${socket.id}`);

    socket.on("userOnline", (email) => {
        if (!email) return;
        onlineUsers[email] = socket.id;
        console.log(`[ONLINE] User online: ${email}. Total online: ${Object.keys(onlineUsers).length}`);
        io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
    });

    socket.on("disconnect", () => {
        const offlineEmail = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
        if (offlineEmail) {
            delete onlineUsers[offlineEmail];
            console.log(`[DISCONNECT] User offline: ${offlineEmail}. Total online: ${Object.keys(onlineUsers).length}`);
            io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
        }
    });

    socket.on("joinChat", (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        // CRITICAL LOGGING: Track room joins
        console.log(`[ROOM] Socket ${socket.id} joined chat: ${chatId}`);
    });

    socket.on("leaveChat", (chatId) => {
        if (!chatId) return;
        socket.leave(chatId);
        console.log(`[ROOM] Socket ${socket.id} left chat: ${chatId}`);
    });

    // ... (All other event handlers remain the same) ...

    socket.on("typing", (chatId, senderEmail) => {
        if (!chatId || !senderEmail) return;
        socket.to(chatId).emit("typing", chatId, senderEmail);
    });

    socket.on("stopTyping", (chatId, senderEmail) => {
        if (!chatId || !senderEmail) return;
        socket.to(chatId).emit("stopTyping", chatId, senderEmail);
    });

    socket.on("messageSeen", (chatId, messageId, viewerEmail) => {
        if (!chatId || !messageId || !viewerEmail) return;
        io.to(chatId).emit("messageSeenUpdate", chatId, messageId, viewerEmail);
        console.log(`[SOCKET_EMIT] 'messageSeenUpdate' in ${chatId} by ${viewerEmail}`);
    });

    socket.on("conversationSeen", async (chatId, viewerEmail) => {
        if (!chatId || !viewerEmail) return;

        socket.to(chatId).emit("conversationSeen", chatId, viewerEmail);
        console.log(`[SOCKET_EMIT] 'conversationSeen' in ${chatId} by ${viewerEmail}`);

        try {
            const chatsCollection = await dbConnect("chats");
            await chatsCollection.updateOne(
                { _id: new ObjectId(chatId), "participants.email": viewerEmail },
                { $set: { "participants.$[viewer].unreadCount": 0 } },
                { arrayFilters: [{ "viewer.email": viewerEmail }] }
            );
            console.log(`[DB] Reset unread count for viewer: ${viewerEmail}`);

        } catch (err) {
            console.error("[DB_ERROR] Failed to reset unreadCount on conversationSeen:", err.message);
        }
    });
});

server.listen(PORT, () => console.log(`✅ Socket server running on port ${PORT}`));

app.get("/", (req, res) => {
    res.send("✅ Socket server is running and listening on the correct port.");
});