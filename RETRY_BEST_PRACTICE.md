# Retry Best Practice - Create NEW Ticket

## The Golden Rule

**To retry a failed ticket: Create a NEW ticket. This triggers the flow immediately.**

## Why NEW Ticket is Best

| Factor | NEW Ticket | Reset + Wait |
|--------|------------|--------------|
| **Speed** | ✅ Immediate | ❌ Unknown |
| **Reliability** | ✅ Guaranteed | ❌ Maybe never |
| **Audit Trail** | ✅ Clear history | ❌ Mixed logs |
| **Debug** | ✅ Fresh start | ❌ Confusing |
| **Control** | ✅ You decide | ❌ Random timing |

## How to Retry

### Option 1: Admin API (RECOMMENDED)

```bash
# Create retry ticket - triggers flow immediately
curl -X POST http://localhost:3001/api/admin/tickets/:failed-ticket-id/retry \
  -H "Content-Type: application/json" \
  -H "x-user-id: admin-id" \
  -H "x-user-email: admin@example.com"

# Response:
{
  "success": true,
  "message": "Retry ticket created and flow triggered immediately",
  "originalTicketId": "old-id",
  "newTicketId": "new-id",
  "note": "This is the BEST option - flow triggers right away"
}
```

### Option 2: User Creates New Ticket

```bash
# User creates new ticket with RETRY prefix
curl -X POST http://localhost:3001/api/tickets \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -H "x-user-email: user@example.com" \
  -d '{
    "description": "RETRY: back button still broken"
  }'

# Flow triggers immediately
```

### Option 3: Admin Panel (UI)

In the admin panel:
1. Find the failed ticket
2. Click "Create Retry Ticket"
3. New ticket created automatically
4. Flow triggers immediately

## What Happens

### NEW Ticket Flow (GOOD)

```
Admin/User → Create NEW ticket
                ↓
    Ticket Created (PENDING)
                ↓
        addTicketToQueue() ← TRIGGERS FLOW
                ↓
        Groq Analyzes
                ↓
        Claude Executes
                ↓
        Done!
```

### Reset Flow (BAD)

```
Admin → Reset ticket to PENDING
            ↓
    Ticket sits in PENDING
            ↓
    ...waiting...
            ↓
    Maybe processes someday
            ↓
    Unclear when/if it runs
```

## API Endpoints

| Endpoint | Purpose | Triggers Flow? |
|----------|---------|----------------|
| `POST /api/tickets` | User creates ticket | ✅ YES |
| `POST /api/webhooks/chat-ticket` | External webhook | ✅ YES |
| `POST /api/admin/tickets/:id/retry` | **Create retry ticket (BEST)** | ✅ YES |
| `POST /api/admin/tickets/:id/reset` | Reset to FAILED | ❌ NO |

## Console Output

When you use the BEST option:

```
✅ Retry ticket created: new-ticket-id
   Original: old-ticket-id
   Flow will trigger immediately

🤖 STEP 2a: Groq analyzing context (PRIMARY)...
   User Intent: ...
   ...

📝 STEP 3: Generating optimized prompt...
   🤖 PRIMARY: Groq generating enhanced prompt...
   ✅ Prompt created by Groq (PRIMARY)
```

## Recovery Service Behavior

The recovery service now:

1. **Finds stuck tickets** → Marks as FAILED
2. **Recommends NEW ticket** → Clear message in logs
3. **Never auto-requeues** → Strict trigger policy

```
🔄 Recovery: Found 1 stuck ticket(s)
   ❌ Ticket abc-123...: Marked as FAILED
   💡 RECOMMENDED: Create NEW ticket to retry immediately
```

## Summary

| Question | Answer |
|----------|--------|
| **Best way to retry?** | Create NEW ticket |
| **API endpoint?** | `POST /api/admin/tickets/:id/retry` |
| **Does it trigger immediately?** | ✅ YES |
| **What about reset endpoint?** | Only marks FAILED, doesn't trigger |
| **Auto-recovery?** | ❌ NO - strict trigger policy |

**Remember: Flow ONLY triggers on NEW ticket creation. Create NEW ticket = BEST option.**
