/**
 * Stuck Ticket Recovery Service
 * Resets tickets stuck in PROCESSING state back to PENDING
 * Runs on a scheduled interval
 */

// NOTE: addTicketToQueue is NOT used here - flow only triggers on NEW ticket creation
const prisma = require('./prismaClient');

// Configuration
const CONFIG = {
  STUCK_THRESHOLD_MINUTES: 10, // Consider stuck after 10 minutes
  MAX_RETRIES: 3,              // Max retry attempts per ticket
  CHECK_INTERVAL_MS: 5 * 60 * 1000, // Check every 5 minutes
};

/**
 * Find and recover stuck tickets
 */
async function recoverStuckTickets() {
  const stuckThreshold = new Date(Date.now() - CONFIG.STUCK_THRESHOLD_MINUTES * 60 * 1000);

  try {
    // Find tickets stuck in PROCESSING for too long
    const stuckTickets = await prisma.ticket.findMany({
      where: {
        status: 'PROCESSING',
        updatedAt: {
          lt: stuckThreshold,
        },
      },
      include: {
        user: {
          select: {
            email: true,
            name: true,
          },
        },
      },
    });

    if (stuckTickets.length === 0) {
      return { recovered: 0, failed: 0, details: [] };
    }

    console.log(`\n🔄 Recovery: Found ${stuckTickets.length} stuck ticket(s)`);

    const results = {
      recovered: 0,
      failed: 0,
      details: [],
    };

    for (const ticket of stuckTickets) {
      // Parse execution JSON to get retry count
      let executionData = {};
      try {
        executionData = ticket.executionJson ? JSON.parse(ticket.executionJson) : {};
      } catch (e) {
        executionData = {};
      }

      const retryCount = executionData.retryCount || 0;

      if (retryCount >= CONFIG.MAX_RETRIES) {
        // Max retries exceeded - mark as FAILED
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: 'FAILED',
            errorMessage: `Ticket stuck in PROCESSING after ${CONFIG.MAX_RETRIES} retry attempts`,
            executionJson: JSON.stringify({
              ...executionData,
              finalStatus: 'FAILED',
              failedAt: new Date().toISOString(),
              reason: 'Max retries exceeded',
            }),
          },
        });

        console.log(`   ❌ Ticket ${ticket.id.substring(0, 8)}...: Max retries exceeded, marked as FAILED`);
        results.failed++;
        results.details.push({
          ticketId: ticket.id,
          action: 'marked_failed',
          reason: 'Max retries exceeded',
        });
      } else {
        // Mark as FAILED with instructions to create NEW ticket
        // This is the BEST option: clear failure + new ticket triggers flow
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: 'FAILED',
            errorMessage: `Ticket stuck in PROCESSING after ${retryCount} attempts. RECOMMENDED: Create NEW ticket to retry.`,
            executionJson: JSON.stringify({
              ...executionData,
              finalStatus: 'FAILED',
              failedAt: new Date().toISOString(),
              reason: 'Stuck in PROCESSING - create NEW ticket to retry',
              recommendation: 'Create NEW ticket - this triggers flow immediately',
              originalDescription: ticket.description,
            }),
          },
        });

        console.log(`   ❌ Ticket ${ticket.id.substring(0, 8)}...: Marked as FAILED`);
        console.log(`   💡 RECOMMENDED: Create NEW ticket to retry immediately`);
        results.recovered++;
        results.details.push({
          ticketId: ticket.id,
          action: 'reset_pending',
          retryCount: retryCount + 1,
        });
      }
    }

    console.log(`🔄 Recovery complete: ${results.recovered} recovered, ${results.failed} failed\n`);
    return results;
  } catch (error) {
    console.error('❌ Recovery service error:', error);
    throw error;
  }
}

/**
 * Manual retry for a specific failed ticket
 */
async function retryFailedTicket(ticketId) {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }

    if (ticket.status !== 'FAILED' && ticket.status !== 'WAITING_CLAUDE') {
      return { success: false, error: `Cannot retry ticket in ${ticket.status} status` };
    }

    // Parse execution JSON
    let executionData = {};
    try {
      executionData = ticket.executionJson ? JSON.parse(ticket.executionJson) : {};
    } catch (e) {
      executionData = {};
    }

    // BEST PRACTICE: Create NEW ticket instead of resetting
    // This provides immediate processing and clear audit trail
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'FAILED',
        errorMessage: 'Ticket failed. RECOMMENDED: Create NEW ticket to retry immediately.',
        executionJson: JSON.stringify({
          ...executionData,
          manualRetryAt: new Date().toISOString(),
          previousStatus: ticket.status,
          note: 'FAILED - Create NEW ticket to retry (best option)',
          recommendation: 'Create NEW ticket - flow triggers immediately',
          retryInstructions: {
            method: 'POST /api/tickets',
            body: {
              description: `RETRY: ${ticket.description}`
            }
          }
        }),
      },
    });

    console.log(`🔄 Ticket ${ticketId.substring(0, 8)}... marked as FAILED`);
    console.log(`   💡 RECOMMENDED: Create NEW ticket to retry`);
    console.log(`   📋 Use: POST /api/tickets with description "RETRY: ${ticket.description.substring(0, 30)}..."`);
    return {
      success: true,
      message: 'Ticket marked as FAILED',
      recommendation: 'Create NEW ticket to retry immediately',
      retryInstructions: {
        endpoint: '/api/tickets',
        method: 'POST',
        body: {
          description: `RETRY: ${ticket.description}`
        }
      }
    };
  } catch (error) {
    console.error('❌ Manual retry error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Start the recovery scheduler
 */
function startRecoveryScheduler() {
  console.log(`🔄 Stuck ticket recovery scheduler started (checking every ${CONFIG.CHECK_INTERVAL_MS / 60000} minutes)`);

  // Run immediately on startup
  recoverStuckTickets().catch(console.error);

  // Schedule recurring checks
  const intervalId = setInterval(() => {
    recoverStuckTickets().catch(console.error);
  }, CONFIG.CHECK_INTERVAL_MS);

  return intervalId;
}

/**
 * Create a retry ticket from a failed ticket
 * BEST OPTION: Creates new ticket which triggers flow immediately
 */
async function createRetryTicket(originalTicketId, clientId) {
  try {
    const originalTicket = await prisma.ticket.findUnique({
      where: { id: originalTicketId },
    });

    if (!originalTicket) {
      return { success: false, error: 'Original ticket not found' };
    }

    // Create NEW ticket with retry prefix
    const retryTicket = await prisma.ticket.create({
      data: {
        clientId: clientId || originalTicket.clientId,
        description: `RETRY: ${originalTicket.description}`,
        targetRepoUrl: originalTicket.targetRepoUrl,
        status: 'PENDING',
        imageReferences: originalTicket.imageReferences,
        memoryTrail: JSON.stringify({
          retryOf: originalTicketId,
          retryAt: new Date().toISOString(),
          previousAttempts: originalTicket.executionJson
            ? JSON.parse(originalTicket.executionJson).retryCount || 0
            : 0
        }),
      },
    });

    // NOTE: Flow trigger happens in server.js when ticket is created
    // This is the BEST option - flow triggers immediately

    console.log(`✅ Retry ticket created: ${retryTicket.id}`);
    console.log(`   Original: ${originalTicketId}`);
    console.log(`   Flow will trigger immediately`);

    return {
      success: true,
      ticketId: retryTicket.id,
      originalTicketId: originalTicketId,
      message: 'Retry ticket created - flow triggers immediately',
    };
  } catch (error) {
    console.error('❌ Create retry ticket error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  recoverStuckTickets,
  retryFailedTicket,
  createRetryTicket,
  startRecoveryScheduler,
  CONFIG,
};
