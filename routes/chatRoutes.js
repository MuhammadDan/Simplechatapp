// routes/chatRoutes.js - UPDATED (Remove health check)
async function chatRoutes(fastify) {
  // GET /messages -> list recent messages (latest first)
  fastify.get("/messages", async (req, reply) => {
    const messages = await fastify.db.Message.findAll({
      order: [["createdAt", "DESC"]],
      limit: 50,
    });
    return messages;
  });

  // REMOVE THIS HEALTH CHECK (Already in server.js)
  // fastify.get("/health", async () => ({ ok: true }));
}

module.exports = chatRoutes;