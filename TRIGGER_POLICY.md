# Autobug Trigger Policy

## STRICT RULE: Flow ONLY Triggers on NEW Ticket Creation

The Autobug processing flow **ONLY** triggers when a **NEW ticket is raised** via the API. It does NOT trigger automatically or in any other circumstance.

## What Triggers the Flow

| Trigger | Endpoint | Description |
|---------|----------|-------------|
| ✅ **User creates ticket** | `POST /api/tickets` | User submits new ticket via UI/API |
| ✅ **Webhook ticket** | `POST /api/webhooks/chat-ticket` | External system creates new ticket |

## What Does NOT Trigger the Flow

| Action | Behavior |
|--------|----------|
| ❌ **Auto-recovery** | Stuck tickets are reset to PENDING but NOT re-queued |
| ❌ **Manual retry** | Failed tickets can be reset to PENDING but NOT auto-processed |
| ❌ **Ticket update** | Editing a ticket does NOT trigger processing |
| ❌ **Status change** | Manual status changes do NOT trigger processing |

## How It Works

### New Ticket Flow (TRIGGERS)

```
User → POST /api/tickets
            ↓
    Ticket Created (PENDING)
            ↓
    addTicketToQueue() ← TRIGGERS WORKER
            ↓
    Worker Processes Ticket
```

### Stuck Ticket Recovery (DOES NOT TRIGGER)

```
Recovery Service → Detects stuck ticket
            ↓
    Reset to PENDING
            ↓
    ❌ NO addTicketToQueue() called
            ↓
    Ticket waits in PENDING
            ↓
    Flow triggers ONLY when NEW ticket created
```

### Manual Retry (DOES NOT TRIGGER)

```
Admin → POST /api/admin/tickets/:id/reset
            ↓
    Ticket Reset to PENDING
            ↓
    ❌ NO addTicketToQueue() called
            ↓
    Ticket waits in PENDING
            ↓
    Flow triggers ONLY when NEW ticket created
```

## Why This Design?

1. **Predictability**: You know exactly when processing happens
2. **Control**: No surprise automatic processing
3. **Safety**: Failed/stuck tickets don't auto-retry and cause issues
4. **Clarity**: One trigger = one flow execution

## For Admins: How to Retry a Failed Ticket

Since the flow doesn't auto-trigger on retry, you have two options:

### Option 1: Create New Ticket (Recommended)

```bash
# Create a new ticket with same description
curl -X POST http://localhost:3001/api/tickets \
  -H "Content-Type: application/json" \
  -H "x-user-id: your-user-id" \
  -H "x-user-email: your@email.com" \
  -d '{"description": "Same issue description as before"}'
```

This will:
- Create a new ticket
- Trigger the full Autobug flow
- Process with Groq + Claude

### Option 2: Reset + Wait

```bash
# Reset the failed ticket
curl -X POST http://localhost:3001/api/admin/tickets/:id/reset \
  -H "x-user-id: admin-id" \
  -H "x-user-email: admin@example.com"
```

This will:
- Reset ticket to PENDING
- NOT trigger flow immediately
- Process when the NEXT new ticket is created

## Code Locations

### Where Flow IS Triggered

**File**: `src/server.js`
- Line ~346: `await addTicketToQueue(ticket.id, {...})` - User creates ticket
- Line ~607: `await addTicketToQueue(ticket.id, {...})` - Webhook creates ticket

### Where Flow is NOT Triggered

**File**: `src/services/stuckTicketRecovery.js`
- ❌ Removed: `await addTicketToQueue(ticket.id, {...})` - Was auto-requeue

**File**: `src/server.js`
- ❌ Removed: `/api/admin/tickets/:id/retry` endpoint - Was manual retry trigger
- ✅ New: `/api/admin/tickets/:id/reset` - Only resets status, no trigger

## Verification

To verify the strict trigger policy, search the codebase:

```bash
# Should only find 2 results (the two valid triggers)
grep -n "addTicketToQueue" src/server.js

# Should find NO results (no auto-requeue)
grep -n "addTicketToQueue" src/services/stuckTicketRecovery.js
```

Expected output:
```
src/server.js:346:    await addTicketToQueue(ticket.id, {
src/server.js:607:    await addTicketToQueue(ticket.id, {
```

## Summary

| Question | Answer |
|----------|--------|
| When does flow trigger? | ONLY on NEW ticket creation |
| Does auto-recovery trigger flow? | NO |
| Does manual retry trigger flow? | NO |
| How to retry a failed ticket? | Create NEW ticket |
| How many triggers exist? | 2 (user ticket + webhook) |

**The rule is simple: New ticket = Flow triggers. Everything else = No trigger.**
