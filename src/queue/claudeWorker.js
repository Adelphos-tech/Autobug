require('dotenv').config();
const { Worker } = require('bullmq');
const prisma = require('../services/prismaClient');
const { redisConnection } = require('./agentQueue');

// Claude Code Bridge
const { addTask } = require('../../claude-queue/bridge');

// Initialize Prisma (using shared client)

// SSH Configuration
const SSH_CONFIG = {
  host: process.env.SSH_HOST || '156.67.105.64',
  user: process.env.SSH_USER || 'root',
  password: process.env.SSH_PASSWORD,
  repoPath: process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend'
};

// Create the Worker
const worker = new Worker(
  'ai-agent-queue',
  async (job) => {
    const { ticketId, issueDescription, targetRepoUrl } = job.data;
    console.log(`[ClaudeWorker] Started processing job ${job.id} for ticket ${ticketId}`);

    try {
      // 1. Update Ticket status to PROCESSING
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: 'PROCESSING' },
      });
      console.log(`[ClaudeWorker] Ticket ${ticketId} status updated to PROCESSING`);

      // 2. Add to Claude Code queue (file-based)
      const task = {
        id: ticketId,
        jobId: job.id,
        description: issueDescription,
        repoUrl: targetRepoUrl,
        repoPath: SSH_CONFIG.repoPath,
        ssh: {
          host: SSH_CONFIG.host,
          user: SSH_CONFIG.user,
          password: SSH_CONFIG.password
        },
        instructions: `
You are Claude Code, an autonomous developer fixing bugs.

TASK: Fix the following issue in the repository.

ISSUE DESCRIPTION:
${issueDescription}

REPOSITORY LOCATION:
SSH: ${SSH_CONFIG.user}@${SSH_CONFIG.host}
Path: ${SSH_CONFIG.repoPath}

STEPS TO FOLLOW:
1. SSH into the server and clone/access the repo
2. Analyze the codebase to understand the issue
3. Find relevant files related to the bug
4. Implement the fix
5. Test if possible (run build, check syntax)
6. Commit changes with descriptive message
7. Update task status as complete

IMPORTANT:
- Be careful with production code
- Make minimal changes needed to fix the issue
- Ensure code quality and follow existing patterns
- Test before committing

Ticket ID: ${ticketId}
        `
      };

      const queuedTask = addTask(task);
      console.log(`[ClaudeWorker] Task ${ticketId} added to Claude Code queue`);

      // 3. Update ticket with session ID (queue file path)
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          agentSessionId: `claude-queue-${ticketId}`,
          status: 'WAITING_CLAUDE' // New status indicating waiting for Claude
        },
      });

      console.log(`[ClaudeWorker] Ticket ${ticketId} waiting for Claude to process`);

      // Note: The actual fix happens when Claude polls the queue
      // This worker just queues it - doesn't wait for completion

    } catch (error) {
      console.error(`[ClaudeWorker] Error processing ticket ${ticketId}:`, error.message);

      try {
        await prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'FAILED' },
        });
        console.log(`[ClaudeWorker] Ticket ${ticketId} status updated to FAILED`);
      } catch (dbError) {
        console.error(`[ClaudeWorker] Failed to update ticket status:`, dbError.message);
      }

      throw error;
    }
  },
  {
    connection: redisConnection,
  }
);

worker.on('ready', () => {
  console.log('[ClaudeWorker] BullMQ Worker is ready and listening on ai-agent-queue');
  console.log('[ClaudeWorker] Tasks will be queued for Claude Code to process');
});

worker.on('failed', (job, err) => {
  console.error(`[ClaudeWorker] Job ${job?.id} failed:`, err.message);
});

module.exports = worker;
