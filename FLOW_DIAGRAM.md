# Autobug Ticket Processing Flow - UPDATED

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AUTOBUG SYSTEM FLOW                               │
│                      (With Groq + Claude + Recovery)                         │
└─────────────────────────────────────────────────────────────────────────────┘

Phase 1: TICKET CREATION
═══════════════════════════════════════════════════════════════════════════════

  User (Browser)                    Autobug Server                    Database
        │                                 │                                │
        │  POST /api/tickets                                               │
        │  {                                                             │
        │    description: "Fix header...",                                │
        │    images: ["screenshot.png"]    ← Optional                    │
        │  }                                                             │
        │────────────────────────────────>│                               │
        │                                 │                                │
        │                                 │  1. Image Validation          │
        │                                 │     └─ Verify files exist      │
        │                                 │     └─ Filter missing          │
        │                                 │                                │
        │                                 │  2. Create Ticket             │
        │                                 │     status: PENDING            │
        │                                 │     targetRepoUrl: set         │
        │                                 │───────────────────────────────>│
        │                                 │                                │
        │                                 │  3. Add to BullMQ queue       │
        │                                 │     queue: "ai-agent-queue"    │
        │                                 │                                │
        │                                 │  4. Notify Admins             │
        │                                 │     └─ SSE to all connections  │
        │                                 │     └─ Dead clients cleaned    │
        │  Response: { ticketId }         │                                │
        │<────────────────────────────────│                                │


Phase 2: WORKER PROCESSING
═══════════════════════════════════════════════════════════════════════════════

  Redis Queue                  safe-auto-dispatcher                    Database
        │                                 │                               │
        │  Job: "process-ticket"          │                               │
        │────────────────────────────────>│                               │
        │                                 │                               │
        │                              STEP 1: VALIDATION                 │
        │                                 │                               │
        │                                 │  • Local pattern matching     │
        │                                 │  • Safety checks              │
        │                                 │  • Issue classification       │
        │                                 │  • Complexity assessment      │
        │                                 │                               │
        │                              STEP 2a: GROQ CONTEXT (Optional)   │
        │                                 │                               │
        │                                 │  If GROQ_ENABLED=true:        │
        │                                 │    └─ Analyze user intent     │
        │                                 │    └─ Extract elements        │
        │                                 │    └─ Clarify description     │
        │                                 │    └─ Suggest files           │
        │                                 │    └─ Fallback if fails       │
        │                                 │                               │
        │                              STEP 2b: MEMORY RETRIEVAL          │
        │                                 │                               │
        │                                 │  • Find COMPLETED tickets     │
        │                                 │    (90 days, similar elements)│
        │                                 │  • Build memory trail         │
        │                                 │  • Skip FAILED/REJECTED       │
        │                                 │                               │
        │                              STEP 3: PROMPT GENERATION          │
        │                                 │                               │
        │                                 │  Base Prompt                  │
        │                                 │  + Groq Analysis (if used)    │
        │                                 │  + Memory Trail               │
        │                                 │  → Enhanced Claude Prompt     │
        │                                 │                               │
        │                              STEP 4: EXECUTION PLAN             │
        │                                 │                               │
        │                                 │  • Build safe command plan    │
        │                                 │  • Whitelist validation       │
        │                                 │  • Danger pattern check       │
        │                                 │                               │
        │                              STEP 5: CLAUDE CODE EXECUTION      │
        │                                 │                               │
        │                                 │  • SSH to server (30s timeout)│
        │                                 │  • Read/analyze files         │
        │                                 │  • Apply fixes                │
        │                                 │  • Verify changes             │
        │                                 │                               │
        │                              STEP 6: FINALIZE                   │
        │                                 │                               │
        │                                 │  Status: COMPLETED            │
        │                                 │  ├─ Store execution log       │
        │                                 │  ├─ Store in memory (if OK)  │
        │                                 │  └─ Notify admin              │
        │                                 │                               │
        │                                 │  Status: FAILED               │
        │                                 │  └─ Log error details         │
        │                                 │  └─ Manual retry available    │
        │                                 │                               │
        │                                 │  Status: WAITING_CLAUDE       │
        │                                 │  └─ Needs manual review       │
        │                                 │<──────────────────────────────│


Phase 3: RECOVERY SERVICE (Background)
═══════════════════════════════════════════════════════════════════════════════

  Recovery Scheduler
        │
        │  Runs every 5 minutes
        │
        ├─ Find PROCESSING tickets > 10 min
        │
        ├─ If retry count < 3:
        │     └─ Reset to PENDING
        │     └─ Re-queue
        │
        └─ If retry count >= 3:
              └─ Mark as FAILED
              └─ Requires admin manual retry


Phase 4: ADMIN DASHBOARD
═══════════════════════════════════════════════════════════════════════════════

  Admin Panel (Real-time)
  ├─ SSE Notifications (bell icon + toast)
  │  └─ Auto-cleans dead connections
  │
  ├─ Ticket Management
  │  ├─ View all tickets
  │  ├─ Filter by status
  │  ├─ Execution logs with JSON details
  │  └─ Manual retry for FAILED tickets
  │
  ├─ Stats Dashboard
  │  ├─ Total/Pending/Processing/Completed/Failed counts
  │
  └─ Groq Status (if enabled)
     └─ Enabled/Configured/Model info
```

## Status Transitions

```
┌──────────┐     ┌────────────┐     ┌──────────────────────┐
│  PENDING │────▶│ PROCESSING │────▶│     COMPLETED        │
│          │     │            │     │ (Store in memory)    │
└──────────┘     └────────────┘     └──────────────────────┘
      │                 │                      │
      │                 │                      │
      │                 ▼                      ▼
      │           ┌────────────┐      ┌────────────┐
      │           │   FAILED   │      │WAITING_CLAUDE│
      │           │            │      │ (Manual      │
      │           │(Max retries│      │  review)     │
      │           │ exceeded)  │      └──────┬───────┘
      │           └────────────┘             │
      │                 │                    │
      │                 │                    │
      │                 ▼                    │
      │           ┌────────────┐             │
      └──────────▶│   Retry    │◀────────────┘
                  │ (Manual)   │
                  └────────────┘
```

## Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **Server** | `src/server.js` | Express API, SSE notifications, image uploads |
| **Worker** | `safe-auto-dispatcher.js` | Main ticket processor (6 steps) |
| **Groq Service** | `src/services/groqService.js` | Context analysis & prompt enhancement |
| **Memory Service** | `src/services/memoryService.js` | Learn from similar completed tickets |
| **Recovery Service** | `src/services/stuckTicketRecovery.js` | Reset stuck tickets (5min interval) |
| **Queue** | `src/queue/agentQueue.js` | BullMQ + Redis integration |
| **Validator** | `src/validation/ticketValidator.js` | Safety checks & classification |
| **Prompt Generator** | `prompt-generator.js` | Create prompts with expanded file detection |
| **Admin Panel** | `src/public/admin.html` | Real-time dashboard with notifications |

## What's New (vs Old Flow)

| Feature | Old | Current |
|---------|-----|---------|
| **AI Provider** | Manual Claude only | Groq (context) + Claude (execution) |
| **Notifications** | Polling | Real-time SSE with auto-cleanup |
| **File Detection** | .html/.css/.js only | React, Vue, Svelte, Tailwind, etc |
| **Stuck Tickets** | Manual recovery | Auto-recovery every 5 minutes |
| **Memory** | None | Learn from COMPLETED tickets only |
| **Image Validation** | None | Verify files exist before saving |
| **SSH Timeout** | None | 30s timeout with retry logic |
| **Race Conditions** | Possible | Idempotency checks on manual review |

## Configuration

```env
# Database
DATABASE_URL="file:./dev.db"

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Server
PORT=3001

# SSH (for remote fixing)
SSH_HOST=156.67.105.64
SSH_USER=root
SSH_PASSWORD=your_password
SSH_TIMEOUT_MS=30000

# Repository
DEFAULT_REPO_PATH=/var/www/adelphos_frontend

# Safety
DRY_RUN=false
REQUIRE_CONFIRMATION=false

# Groq (Context Enhancement - Optional)
GROQ_ENABLED=false
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_FALLBACK_ON_ERROR=true
```

## Security Layers

```
Layer 1: Validation (ticketValidator.js)
         └─ Pattern matching, safety checks

Layer 2: Whitelist (safe-auto-dispatcher.js:65-86)
         └─ Only pre-approved commands

Layer 3: Danger Detection (safe-auto-dispatcher.js:91-113)
         └─ Block rm -rf, sudo, etc

Layer 4: SSH Timeout (30s default)
         └─ Prevent hanging connections

Layer 5: Manual Review Gate
         └─ Complex issues → WAITING_CLAUDE

Layer 6: Retry Limits (3 max)
         └─ Auto-recovery → Manual retry
```

## Data Example

### Execution Log (with Groq)
```json
{
  "ticketId": "abc-123",
  "result": { "filesChanged": ["Button.css"], ... },
  "contextProvider": "groq",
  "codeExecutor": "claude-code",
  "groqModel": "llama-3.3-70b-versatile",
  "groqContext": {
    "userIntent": "Standardize back button styling",
    "affectedElements": ["back-button"],
    "confidence": 0.85
  },
  "enhancedByGroq": true,
  "duration": 12.5,
  "timestamp": "2026-05-27T..."
}
```

### Ticket Status Flow
```
PENDING → PROCESSING (6 steps) → COMPLETED
            │
            ├─ Groq Analysis (optional)
            ├─ Memory Retrieval
            ├─ Claude Code Execution
            └─ Finalize & Store
```
