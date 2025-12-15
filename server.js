require("dotenv").config();
const Fastify = require("fastify");
const socketio = require("socket.io");
const path = require("path");
const sequelize = require("./config/database");
const Message = require("./models/Message");

// Fastify instance
const app = Fastify({ logger: false });

// Attach models to fastify for routes
app.decorate("db", { Message });

// Routes
app.register(require("./routes/chatRoutes"));

// Serve static files from /public at /
app.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/", // http://localhost:3000/
});

// Socket.IO on Fastify's native server
const server = app.server;
const io = socketio(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Socket.IO logic
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("chat message", async (data) => {
    try {
      const { username, text } = data || {};
      const name = (username || "Anonymous").trim();
      const msgText = (text || "").trim();
      if (!msgText) return;

      // Save in DB
      const saved = await Message.create({ username: name, text: msgText });

      // Broadcast
      io.emit("chat message", {
        sender: saved.username,
        text: saved.text,
        createdAt: saved.createdAt,
      });
    } catch (err) {
      console.error("Error handling chat message:", err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Boot server (Docker ready)
const start = async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();

    const port = Number(process.env.APP_PORT) || 3000;

    // IMPORTANT: Docker ke liye host 0.0.0.0
    await app.listen({
      port,
      host: "0.0.0.0",
    });

    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    console.error("Server start error:", err);
    process.exit(1);
  }
};

start();