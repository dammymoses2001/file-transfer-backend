const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
  // Add these configuration options
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  connectionStateRecovery: {
    // Enable reconnection logic
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
});

// Store votes in memory (for production, use a database)
let votes = { yes: 0, no: 0, email: [] };

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Add these events for better connection monitoring
  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, "Reason:", reason);
  });

  socket.on("error", (error) => {
    console.log("Socket error:", error);
  });
  // Send current votes to newly connected client
  socket.emit("voteUpdate", votes);

  // Handle new votes
  socket.on("newVote", (type, email) => {
    if (type === "yes" || type === "no") {
      votes[type]++;
      if (email) {
        const emailExist = votes.email?.find(
          (checkEmail) => email === checkEmail
        );
        if (emailExist) {
          return socket.emit("emailExists", "This email has already voted.");
        }
        if (!emailExist) {
          votes?.email?.push(email);
          io.emit("voteUpdate", votes);
        }
      }
      // Broadcast updated votes to all clients
      console.log(votes, email);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:-------------", socket.id);
  });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
