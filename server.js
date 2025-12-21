require("dotenv").config();
const Fastify = require("fastify");
const socketio = require("socket.io");
const path = require("path");
const sequelize = require("./config/database");
const Message = require("./models/Message");

// Fastify instance
const app = Fastify({ logger: false });

// ========== ADAPTER PATTERN IMPLEMENTATION ==========

// 1. DATABASE ADAPTER
class DatabaseAdapter {
  constructor(sequelize) {
    this.db = sequelize;
  }

  async saveMessage(data) {
    try {
      const saved = await Message.create({
        username: data.username || 'Anonymous',
        text: data.text
      });
      return { success: true, data: saved };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getMessages(limit = 50) {
    try {
      const messages = await Message.findAll({
        order: [["createdAt", "DESC"]],
        limit
      });
      return { success: true, data: messages };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkHealth() {
    try {
      await this.db.authenticate();
      return { healthy: true, message: "Database connected" };
    } catch (error) {
      return { healthy: false, message: error.message };
    }
  }
}

// 2. SOCKET ADAPTER for multiple server
class SocketAdapter {
  constructor(io) {
    this.io = io;
    this.clients = new Map();
  }

  handleConnection(socket) {
    const clientId = socket.id;
    this.clients.set(clientId, {
      socket: socket,
      connectedAt: new Date()
    });
    console.log(`📡 Client ${clientId} connected`);
    return socket;
  }

  handleDisconnection(socketId) {
    if (this.clients.has(socketId)) {
      this.clients.delete(socketId);
      console.log(`📡 Client ${socketId} disconnected`);
    }
  }

  broadcast(event, data) {
    this.io.emit(event, data);
  }

  sendToClient(socketId, event, data) {
    const client = this.clients.get(socketId);
    if (client && client.socket) {
      client.socket.emit(event, data);
      return true;
    }
    return false;
  }

  broadcastExcept(senderSocketId, event, data) {
    const sender = this.clients.get(senderSocketId);
    if (sender && sender.socket) {
      sender.socket.broadcast.emit(event, data);
    }
  }

  getConnectedClients() {
    return Array.from(this.clients.keys());
  }

  getClientCount() {
    return this.clients.size;
  }
}

// 3. MESSAGE SERVICE
class MessageService {
  constructor(databaseAdapter, socketAdapter) {
    this.db = databaseAdapter;
    this.socket = socketAdapter;
  }

  async sendMessage(messageData, senderSocketId = null) {
    if (!messageData.text || messageData.text.trim() === '') {
      return {
        success: false,
        error: 'Message cannot be empty',
        code: 'VALIDATION_ERROR'
      };
    }

    const dbResult = await this.db.saveMessage({
      username: messageData.username || 'Anonymous',
      text: messageData.text.trim()
    });

    if (!dbResult.success) {
      return {
        success: false,
        error: dbResult.error || 'Failed to save message',
        code: 'DATABASE_ERROR'
      };
    }

    const broadcastData = {
      id: dbResult.data.id,
      sender: dbResult.data.username,
      text: dbResult.data.text,
      createdAt: dbResult.data.createdAt,
      isBroadcast: true
    };

    if (senderSocketId) {
      this.socket.broadcastExcept(senderSocketId, 'chat message', broadcastData);
    } else {
      this.socket.broadcast('chat message', broadcastData);
    }

    return {
      success: true,
      data: dbResult.data,
      broadcastData: broadcastData
    };
  }
}

// ========== INITIALIZE ADAPTERS (LATER) ==========
let databaseAdapter = null;
let socketAdapter = null;
let messageService = null;

// ========== FASTIFY ROUTES ==========

// Health check
app.get('/health', async (request, reply) => {
  try {
    const dbHealth = databaseAdapter ? await databaseAdapter.checkHealth() : { healthy: false, message: 'Not initialized' };
    const socketInfo = socketAdapter ? {
      healthy: true,
      connectedClients: socketAdapter.getClientCount()
    } : { healthy: false, message: 'Not initialized' };

    return {
      status: 'healthy',
      services: {
        database: dbHealth,
        websocket: socketInfo
      }
    };
  } catch (error) {
    reply.code(503);
    return { status: 'unhealthy', error: error.message };
  }
});

// Get messages
app.get('/api/messages', async (request, reply) => {
  if (!databaseAdapter) {
    reply.code(503);
    return { error: 'Database adapter not ready' };
  }
  
  const result = await databaseAdapter.getMessages();
  if (result.success) {
    return result.data;
  } else {
    reply.code(500);
    return { error: result.error };
  }
});

// Socket info
app.get('/api/socket-info', async (request, reply) => {
  if (!socketAdapter) {
    return { error: 'Socket adapter not initialized' };
  }
  
  return {
    connectedClients: socketAdapter.getClientCount(),
    clients: socketAdapter.getConnectedClients()
  };
});

// Serve static files
app.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

// ========== SOCKET.IO SETUP Rellience==========
const server = app.server;
const io = socketio(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Initialize adapters after io is created
databaseAdapter = new DatabaseAdapter(sequelize);
socketAdapter = new SocketAdapter(io);
messageService = new MessageService(databaseAdapter, socketAdapter);

// 🔴 IMPORTANT: DECORATE ONLY ONCE! (Line ~190)
app.decorate("adapters", {
  getDatabaseAdapter: () => databaseAdapter,
  getSocketAdapter: () => socketAdapter,
  getMessageService: () => messageService
});

// ========== SOCKET.IO EVENT HANDLING ==========
io.on("connection", (socket) => {
  const clientSocket = socketAdapter.handleConnection(socket);
  
  console.log("✅ User connected:", socket.id);

  clientSocket.on("chat message", async (data, acknowledgementCallback) => {
    try {
      const result = await messageService.sendMessage(data, socket.id);

      if (acknowledgementCallback) {
        if (result.success) {
          acknowledgementCallback({
            status: 'success',
            messageId: result.data.id,
            sender: result.data.username,
            text: result.data.text,
            timestamp: result.data.createdAt,
            code: 'MESSAGE_SENT'
          });

          // Send to sender for UI update
          socketAdapter.sendToClient(socket.id, 'chat message', {
            ...result.broadcastData,
            isOwnMessage: true
          });
        } else {
          acknowledgementCallback({
            status: 'error',
            message: result.error,
            code: result.code
          });
        }
      }
    } catch (err) {
      console.error("Error:", err.message);
      if (acknowledgementCallback) {
        acknowledgementCallback({
          status: 'error',
          message: 'Internal server error'
        });
      }
    }
  });

  clientSocket.on("disconnect", () => {
    socketAdapter.handleDisconnection(socket.id);
    console.log("❌ User disconnected:", socket.id);
  });
});

// ========== DATABASE CONNECTION ==========
// Rellience
async function connectDatabaseWithRetry(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await sequelize.authenticate();
      console.log('✅ Database connected');
      return true;
    } catch (error) {
      console.error(`❌ Attempt ${i + 1}/${retries} failed:`, error.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error('Failed to connect to database');
}

// ========== GRACEFUL SHUTDOWN Rellience==========
async function gracefulShutdown() {
  console.log('🔄 Shutting down...');
  await app.close();
  await sequelize.close();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ========== START SERVER ==========
const start = async () => {
  try {
    await connectDatabaseWithRetry();
    await sequelize.sync();

    const port = Number(process.env.PORT || process.env.APP_PORT) || 3000;

    await app.listen({
      port,
      host: "0.0.0.0",
    });

    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log(`📊 Health: http://localhost:${port}/health`);
    console.log(`💬 Messages: http://localhost:${port}/api/messages`);
    console.log(`🔌 Socket info: http://localhost:${port}/api/socket-info`);
    
  } catch (err) {
    console.error(" Server start error:", err);
    process.exit(1);
  }
};

start();