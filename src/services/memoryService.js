/**
 * Memory Service
 * Stores and retrieves context from previous tickets
 * Improves handling of similar issues by learning from history
 */

const prisma = require('./prismaClient');

/**
 * Extract key elements from a ticket description
 */
function extractElements(description) {
  const desc = (description || '').toLowerCase();
  const elements = [];

  // Common UI elements
  const elementPatterns = [
    { pattern: /\bback\s+(?:button|site|btn)\b/, element: 'back-button' },
    { pattern: /\bnav(?:igation)?(?:\s+bar)?\b/, element: 'navbar' },
    { pattern: /\bmenu(?:\s+button)?\b/, element: 'menu-button' },
    { pattern: /\bheader\b/, element: 'header' },
    { pattern: /\bfooter\b/, element: 'footer' },
    { pattern: /\bhero(?:\s+section)?\b/, element: 'hero' },
    { pattern: /\bbanner\b/, element: 'banner' },
    { pattern: /\blogo\b/, element: 'logo' },
    { pattern: /\bcard\b/, element: 'card' },
    { pattern: /\bform\b/, element: 'form' },
    { pattern: /\binput|field\b/, element: 'input-field' },
    { pattern: /\bbutton\b/, element: 'button' },
    { pattern: /\blink\b/, element: 'link' },
    { pattern: /\bmodal|dialog|popup\b/, element: 'modal' },
  ];

  for (const { pattern, element } of elementPatterns) {
    if (pattern.test(desc)) {
      elements.push(element);
    }
  }

  // Remove duplicates
  return [...new Set(elements)];
}

/**
 * Find similar tickets from memory
 */
async function findSimilarTickets(ticket) {
  const elements = extractElements(ticket.description);
  const desc = (ticket.description || '').toLowerCase();

  // Search strategies:
  // 1. Same user + similar description
  // 2. Same element mentioned
  // 3. Similar issue type

  const whereConditions = [
    { status: 'COMPLETED' },
    { createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } }, // Last 90 days
  ];

  // Build OR conditions for elements
  if (elements.length > 0) {
    whereConditions.push({
      OR: elements.map(el => ({
        description: { contains: el.replace('-', ' ') }
      }))
    });
  }

  // Also check memory table - only for successfully resolved tickets
  const memoryResults = await prisma.ticketMemory.findMany({
    where: {
      AND: [
        { userId: ticket.clientId },
        { createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  // Get full ticket details for memory - only include COMPLETED tickets
  const memoryTicketIds = memoryResults.map(m => m.ticketId).filter(Boolean);
  let memoryTickets = [];
  if (memoryTicketIds.length > 0) {
    memoryTickets = await prisma.ticket.findMany({
      where: {
        AND: [
          { id: { in: memoryTicketIds } },
          { status: 'COMPLETED' }, // Only include successfully resolved tickets
        ],
      },
    });
  }

  // Find similar tickets by description similarity
  const similarTickets = await prisma.ticket.findMany({
    where: {
      AND: whereConditions,
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  // Combine and deduplicate
  const allTickets = [...memoryTickets, ...similarTickets];
  const seen = new Set();
  const unique = allTickets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return unique;
}

/**
 * Build memory context for a ticket
 */
async function buildMemoryContext(ticket) {
  const similarTickets = await findSimilarTickets(ticket);

  if (similarTickets.length === 0) {
    return null;
  }

  // Format memory context
  const memoryTrail = similarTickets.map(t => ({
    ticketId: t.id,
    description: t.description,
    status: t.status,
    resolution: t.executionJson ? extractResolution(t.executionJson) : null,
    createdAt: t.createdAt,
  }));

  return {
    hasMemory: true,
    similarCount: similarTickets.length,
    memoryTrail: JSON.stringify(memoryTrail),
    contextMessage: formatMemoryContext(similarTickets),
  };
}

/**
 * Extract resolution info from execution JSON
 */
function extractResolution(executionJson) {
  try {
    const exec = JSON.parse(executionJson);
    return exec.summary || 'Fixed automatically';
  } catch {
    return 'Resolved';
  }
}

/**
 * Format memory context for prompt
 */
function formatMemoryContext(similarTickets) {
  if (similarTickets.length === 0) return '';

  const lines = ['\n📚 MEMORY TRAIL (Previous Similar Tickets):'];

  similarTickets.forEach((ticket, i) => {
    lines.push(`\n   ${i + 1}. Ticket #${ticket.id.substring(0, 8)}...`);
    lines.push(`      Issue: "${ticket.description.substring(0, 80)}..."`);
    lines.push(`      Status: ${ticket.status}`);
    if (ticket.executionJson) {
      try {
        const exec = JSON.parse(ticket.executionJson);
        if (exec.summary) {
          lines.push(`      Resolution: ${exec.summary}`);
        }
      } catch {}
    }
  });

  lines.push('\n   💡 Learn from these similar issues when fixing the current ticket.');

  return lines.join('\n');
}

/**
 * Store ticket in memory after resolution
 * Only stores memory for successfully completed tickets
 */
async function storeTicketMemory(ticket, issueType) {
  // Only store memory for successfully completed tickets
  if (ticket.status !== 'COMPLETED') {
    console.log(`   ⏭️ Skipping memory storage: ticket ${ticket.id.substring(0, 8)} status is ${ticket.status}`);
    return;
  }

  const elements = extractElements(ticket.description);

  // Skip if no elements found
  if (elements.length === 0) {
    console.log(`   ⏭️ Skipping memory storage: no elements extracted from ticket ${ticket.id.substring(0, 8)}`);
    return;
  }

  // Store each element as separate memory entry
  for (const element of elements) {
    await prisma.ticketMemory.create({
      data: {
        userId: ticket.clientId,
        ticketId: ticket.id,
        element,
        issueType: issueType || 'general',
        pattern: ticket.description.toLowerCase().substring(0, 200),
        description: ticket.description,
        resolution: ticket.executionJson ? extractResolution(ticket.executionJson) : null,
      },
    });
  }

  console.log(`   💾 Memory stored: ${elements.length} element(s) from ticket ${ticket.id.substring(0, 8)}`);
}

/**
 * Get memory stats for a user
 */
async function getUserMemoryStats(userId) {
  const memories = await prisma.ticketMemory.groupBy({
    by: ['element', 'issueType'],
    where: { userId },
    _count: { id: true },
  });

  return memories;
}

module.exports = {
  buildMemoryContext,
  storeTicketMemory,
  getUserMemoryStats,
  extractElements,
};
