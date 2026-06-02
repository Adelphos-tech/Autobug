const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Create a Redis connection. BullMQ requires maxRetriesPerRequest to be null.
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});

// Initialize the BullMQ queue
const agentQueue = new Queue('ai-agent-queue', {
  connection: redisConnection,
});

/**
 * Pushes a new ticket task onto the AI agent queue.
 * @param {string} ticketId - Database ID of the ticket
 * @param {Object} taskDetails - Details of the task
 * @param {string} taskDetails.issueDescription - Description of the issue to solve
 * @param {string} taskDetails.targetRepoUrl - Repository URL to work on
 */
async function addTicketToQueue(ticketId, taskDetails) {
  try {
    const job = await agentQueue.add('process-ticket', {
      ticketId,
      issueDescription: taskDetails.issueDescription,
      targetRepoUrl: taskDetails.targetRepoUrl,
    });
    console.log(`Successfully queued job ${job.id} for ticket ${ticketId}`);
    return job;
  } catch (error) {
    console.error(`Failed to queue job for ticket ${ticketId}:`, error);
    throw error;
  }
}

module.exports = {
  addTicketToQueue,
  agentQueue,
  redisConnection,
};
