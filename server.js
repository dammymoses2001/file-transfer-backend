const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");

const app = express();
// CORS configuration
const allowedOrigins = [
  "http://localhost:5173", // Local development
  "https://file-transfer-frontend-eight.vercel.app", // Production frontend
  /^https:\/\/.*\.vercel\.app$/ // Any Vercel subdomain for testing
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    // Check if origin is allowed
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return allowedOrigin === origin;
      } else {
        return allowedOrigin.test(origin);
      }
    });
    
    callback(null, isAllowed);
  },
  credentials: true,
}));
app.use(express.json());

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, etc.)
      if (!origin) return callback(null, true);
      
      // Check if origin is allowed
      const isAllowed = allowedOrigins.some(allowedOrigin => {
        if (typeof allowedOrigin === 'string') {
          return allowedOrigin === origin;
        } else {
          return allowedOrigin.test(origin);
        }
      });
      
      callback(null, isAllowed);
    },
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8, // 100MB for file transfers
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// Data structures for managing connections and file transfers
const users = {};
const rooms = new Map(); // PIN -> { creator, participants: [], createdAt }
const activeTransfers = new Map(); // transferId -> { from, to, fileName, fileSize, chunks }

// Generate a random 6-digit PIN
function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Clean up expired rooms (older than 1 hour)
function cleanupExpiredRooms() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [pin, room] of rooms.entries()) {
    if (room.createdAt < oneHourAgo) {
      rooms.delete(pin);
    }
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupExpiredRooms, 30 * 60 * 1000);

// REST API endpoints
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activeTransfers: activeTransfers.size 
  });
});

app.get("/api/room/:pin", (req, res) => {
  const { pin } = req.params;
  const room = rooms.get(pin);
  
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  
  res.json({
    pin,
    participants: room.uniqueUsers ? room.uniqueUsers.size : room.participants.length,
    createdAt: room.createdAt,
    isActive: true,
  });
});

app.post("/api/room", (req, res) => {
  let pin = generatePIN();
  
  // Ensure PIN is unique
  while (rooms.has(pin)) {
    pin = generatePIN();
  }
  
  rooms.set(pin, {
    creator: "web-api",
    participants: [],
    uniqueUsers: new Set(),
    createdAt: Date.now(),
  });
  
  res.json({ pin, createdAt: Date.now() });
});

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Create a new room with PIN
  socket.on("create_room", ({ userId }, callback) => {
    let pin = generatePIN();
    
    // Ensure PIN is unique
    while (rooms.has(pin)) {
      pin = generatePIN();
    }
    
    rooms.set(pin, {
      creator: socket.id,
      creatorUserId: userId,
      participants: [{ socketId: socket.id, userId }],
      uniqueUsers: new Set([userId]),
      createdAt: Date.now(),
    });
    
    socket.join(pin);
    console.log(`Room created with PIN: ${pin} by ${socket.id} (userId: ${userId})`);
    
    callback({ success: true, pin });
  });

  // Join a room with PIN
  socket.on("join_room", ({ pin, userId }, callback) => {
    const room = rooms.get(pin);
    
    if (!room) {
      callback({ success: false, error: "Invalid PIN" });
      return;
    }
    
    // Check if this socket is already in the room
    const existingParticipant = room.participants.find(p => p.socketId === socket.id);
    if (existingParticipant) {
      callback({ success: false, error: "Already in room" });
      return;
    }
    
    // Add participant with unique user tracking
    room.participants.push({ socketId: socket.id, userId });
    room.uniqueUsers.add(userId);
    socket.join(pin);
    
    // Notify other participants
    socket.to(pin).emit("user_joined", { socketId: socket.id, userId });
    
    console.log(`User ${socket.id} (userId: ${userId}) joined room ${pin}`);
    callback({ 
      success: true, 
      participants: room.uniqueUsers.size, // Count unique users, not socket connections
      isCreator: room.creator === socket.id 
    });
  });

  // Leave room
  socket.on("leave_room", ({ pin }) => {
    const room = rooms.get(pin);
    if (room) {
      // Find and remove the participant
      const participant = room.participants.find(p => p.socketId === socket.id);
      if (participant) {
        room.participants = room.participants.filter(p => p.socketId !== socket.id);
        
        // Check if this was the last connection for this userId
        const stillHasUser = room.participants.some(p => p.userId === participant.userId);
        if (!stillHasUser) {
          room.uniqueUsers.delete(participant.userId);
        }
        
        socket.leave(pin);
        socket.to(pin).emit("user_left", { socketId: socket.id, userId: participant.userId });
        
        // Delete room if empty
        if (room.participants.length === 0) {
          rooms.delete(pin);
          console.log(`Room ${pin} deleted - no participants`);
        }
      }
    }
  });

  // File transfer initiation
  socket.on("initiate_file_transfer", ({ pin, fileName, fileSize, fileType }, callback) => {
    const room = rooms.get(pin);
    
    if (!room) {
      callback({ success: false, error: "Room not found" });
      return;
    }
    
    const transferId = `${socket.id}_${Date.now()}`;
    const recipients = room.participants.filter(p => p.socketId !== socket.id).map(p => p.socketId);
    
    if (recipients.length === 0) {
      callback({ success: false, error: "No recipients in room" });
      return;
    }
    
    activeTransfers.set(transferId, {
      from: socket.id,
      pin,
      fileName,
      fileSize,
      fileType,
      chunks: [],
      totalChunks: 0,
      recipients,
      startTime: Date.now(),
    });
    
    // Notify recipients about incoming file
    socket.to(pin).emit("incoming_file", {
      transferId,
      fileName,
      fileSize,
      fileType,
      from: socket.id,
    });
    
    callback({ success: true, transferId });
  });

  // Handle file chunks
  socket.on("file_chunk", ({ transferId, chunkIndex, chunkData, isLast }) => {
    const transfer = activeTransfers.get(transferId);
    
    if (!transfer || transfer.from !== socket.id) {
      socket.emit("transfer_error", { transferId, error: "Invalid transfer" });
      return;
    }
    
    transfer.chunks[chunkIndex] = chunkData;
    
    if (isLast) {
      transfer.totalChunks = chunkIndex + 1;
    }
    
    // Check if all chunks received
    const receivedChunks = transfer.chunks.filter(chunk => chunk !== undefined).length;
    const progress = Math.round((receivedChunks / (transfer.totalChunks || 1)) * 100);
    
    // Notify sender of progress
    socket.emit("upload_progress", { transferId, progress });
    
    // If transfer complete, send to recipients
    if (isLast && receivedChunks === transfer.totalChunks) {
      const completeFile = Buffer.concat(transfer.chunks.map(chunk => Buffer.from(chunk)));
      
      // Send file to all recipients in the room
      socket.to(transfer.pin).emit("file_received", {
        transferId,
        fileName: transfer.fileName,
        fileType: transfer.fileType,
        fileData: completeFile,
        from: socket.id,
      });
      
      // Notify sender of completion
      socket.emit("transfer_complete", { transferId });
      
      // Clean up
      activeTransfers.delete(transferId);
      console.log(`File transfer completed: ${transfer.fileName}`);
    }
  });

  // Accept/reject file transfer
  socket.on("respond_to_file", ({ transferId, accept }, callback) => {
    const transfer = activeTransfers.get(transferId);
    
    if (!transfer) {
      callback({ success: false, error: "Transfer not found" });
      return;
    }
    
    if (accept) {
      socket.emit("download_ready", { transferId });
      callback({ success: true });
    } else {
      // Notify sender of rejection
      io.to(transfer.from).emit("transfer_rejected", { 
        transferId, 
        rejectedBy: socket.id 
      });
      callback({ success: true });
    }
  });

  // Get room info
  socket.on("get_room_info", ({ pin }, callback) => {
    const room = rooms.get(pin);
    
    if (!room) {
      callback({ success: false, error: "Room not found" });
      return;
    }
    
    callback({
      success: true,
      participants: room.uniqueUsers.size, // Use unique user count
      isCreator: room.creator === socket.id,
      createdAt: room.createdAt,
    });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    
    // Remove from all rooms
    for (const [pin, room] of rooms.entries()) {
      const participant = room.participants.find(p => p.socketId === socket.id);
      if (participant) {
        room.participants = room.participants.filter(p => p.socketId !== socket.id);
        
        // Check if this was the last connection for this userId
        const stillHasUser = room.participants.some(p => p.userId === participant.userId);
        if (!stillHasUser) {
          room.uniqueUsers.delete(participant.userId);
        }
        
        socket.to(pin).emit("user_left", { socketId: socket.id, userId: participant.userId });
        
        // Delete room if empty
        if (room.participants.length === 0) {
          rooms.delete(pin);
          console.log(`Room ${pin} deleted - creator disconnected`);
        }
      }
    }
    
    // Clean up active transfers
    for (const [transferId, transfer] of activeTransfers.entries()) {
      if (transfer.from === socket.id) {
        activeTransfers.delete(transferId);
        // Notify recipients that transfer was cancelled
        io.to(transfer.pin).emit("transfer_cancelled", { transferId });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

// For Vercel, export the app
if (process.env.NODE_ENV === 'production') {
  module.exports = app;
} else {
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
