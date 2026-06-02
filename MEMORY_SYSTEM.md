# Memory System for Autobug

## Overview
Stores and retrieves context from previous tickets to improve handling of similar issues.

## How it works

### Memory Types
1. **User Memory** - Tickets from the same user (preferences, patterns)
2. **Element Memory** - Similar UI elements (back button, navbar, etc.)
3. **Issue Memory** - Similar issue types (CSS, functionality, etc.)

### Storage
- SQLite database table: `TicketMemory`
- Links: userId ↔ ticket patterns
- Retention: Last 90 days

### Usage
When a new ticket is raised:
1. Extract key elements from description
2. Search memory for similar tickets
3. Include context in prompt: "Previous similar tickets..."
4. Learn from resolution and update memory

## Schema

```sql
CREATE TABLE TicketMemory (
  id TEXT PRIMARY KEY,
  userId TEXT,
  element TEXT, -- e.g., "back-button", "navbar"
  issueType TEXT, -- e.g., "css-styling"
  pattern TEXT, -- regex/searchable pattern
  resolution TEXT, -- how it was fixed
  ticketId TEXT, -- reference to original ticket
  createdAt DATETIME,
  FOREIGN KEY (ticketId) REFERENCES Ticket(id)
);
```

## Retrieval Logic

```javascript
// Find similar tickets
const similarTickets = await prisma.ticket.findMany({
  where: {
    AND: [
      { OR: [
        { description: { contains: element } },
        { description: { contains: issueType } }
      ]},
      { status: 'COMPLETED' },
      { createdAt: { gte: daysAgo(90) }}
    ]
  },
  orderBy: { createdAt: 'desc' },
  take: 3
});
```
