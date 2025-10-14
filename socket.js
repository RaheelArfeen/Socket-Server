import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import { ObjectId } from "mongodb";
import dbConnect from "./db.js";

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
});

app.use(bodyParser.json());

if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI must be defined in your .env file");
}

let onlineUsers = {};

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

app.post("/api/socket/emit", async (req, res) => {
    const { chatId, action, data } = req.body;

    if (!chatId || !action || !data) {
        return res.status(400).send({ error: "Missing required fields" });
    }

    if (action === "newMessage") {
        const { savedMsg, optimisticId } = data;

        const finalMsg = { ...savedMsg, optimisticId };

        const senderEmail = savedMsg?.sender?.email;
        const recipientEmail = savedMsg?.receiver?.email;

        if (!senderEmail || !recipientEmail) {
            return res.status(200).send({ success: true, warning: "Missing participant info" });
        }

        io.to(chatId).emit("newMessage", finalMsg);

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

        const recipientSocketId = onlineUsers[recipientEmail];

        if (recipientSocketId) {

            const updateData = await fetchRecipientUnreadCount(chatId, recipientEmail);

            io.to(recipientSocketId).emit("conversationUpdate", {
                chatId,
                ...updateData,
                lastMessageSenderEmail: senderEmail
            });
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

io.on("connection", (socket) => {

    socket.on("userOnline", (email) => {
        if (!email) return;
        onlineUsers[email] = socket.id;
        io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
    });

    socket.on("disconnect", () => {
        const offlineEmail = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
        if (offlineEmail) {
            delete onlineUsers[offlineEmail];
            io.emit("onlineUsersUpdate", Object.keys(onlineUsers));
        }
    });

    socket.on("joinChat", (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
    });

    socket.on("leaveChat", (chatId) => {
        if (!chatId) return;
        socket.leave(chatId);
    });

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
    });

    socket.on("conversationSeen", async (chatId, viewerEmail) => {
        if (!chatId || !viewerEmail) return;

        socket.to(chatId).emit("conversationSeen", chatId, viewerEmail);

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

server.listen(PORT, () => console.log(`✅ Socket server running on port ${PORT}`));

app.get("/", (req, res) => {
    res.send("✅ Socket server is running and listening on the correct port.");
});