require('dotenv').config();
const { Worker } = require('bullmq');
const axios = require('axios');
const prisma = require('../services/prismaClient');
const { redisConnection } = require('./agentQueue');

// Initialize Prisma (using shared client)

// Create the Worker
const worker = new Worker(
  'ai-agent-queue',
  async (job) => {
    const { ticketId, issueDescription, targetRepoUrl } = job.data;
    console.log(`[Worker] Started processing job ${job.id} for ticket ${ticketId}`);

    try {
      // 1. Update Ticket status to PROCESSING
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: 'PROCESSING' },
      });
      console.log(`[Worker] Ticket ${ticketId} status updated to PROCESSING`);

      // 2. Format strict prompt string
      const prompt = `Task: You are an autonomous developer fixing a customer issue. Issue: ${issueDescription}. 1. Classify if this is frontend/backend. 2. Find relevant files. 3. Fix code. 4. Run tests. 5. Save.`;

      // 3. Make HTTP POST request to local OpenHands REST API
      console.log(`[Worker] Sending request to OpenHands API for ticket ${ticketId}`);
      const response = await axios.post('http://localhost:3000/api/run-agent', {
        prompt,
        targetRepoUrl,
      });

      // 4. Capture session_id and update Ticket record
      const sessionId = response.data?.session_id || response.data?.sessionId;
      if (!sessionId) {
        throw new Error('OpenHands API did not return a session_id');
      }

      await prisma.ticket.update({
        where: { id: ticketId },
        data: { agentSessionId: sessionId },
      });
      console.log(`[Worker] Ticket ${ticketId} updated with agentSessionId: ${sessionId}`);

    } catch (error) {
      console.error(`[Worker] Error processing ticket ${ticketId}:`, error.message);

      // If OpenHands API fails, update status to FAILED in the database
      try {
        await prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'FAILED' },
        });
        console.log(`[Worker] Ticket ${ticketId} status updated to FAILED`);
      } catch (dbError) {
        console.error(`[Worker] Failed to update ticket status to FAILED in DB:`, dbError.message);
      }

      // Rethrow to let BullMQ know the job failed
      throw error;
    }
  },
  {
    connection: redisConnection,
  }
);

worker.on('ready', () => {
  console.log('[Worker] BullMQ Worker is ready and listening on ai-agent-queue');
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err.message);
});

module.exports = worker;
