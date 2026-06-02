# Autobug - Complete Automated Flow

## ✅ System Successfully Built!

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AUTOBUG AUTOMATED TICKET FLOW                         │
└─────────────────────────────────────────────────────────────────────────────┘

   USER (via UI/API)                                                     DATABASE
        │                                                                     │
        │ POST /api/webhooks/chat-ticket                                     │
        │ {                                                                  │
        │   "clientId": "user-001",                                          │
        │   "description": "Add pricing link",                               │
        │   "targetRepoUrl": "/var/www/..."                                   │
        │ }                                                                  │
        │────────────────────────────────>│                                 │
        │                               │ 1. Save ticket                     │
        │                               │    status: "PENDING"              │
        │                               │───────────────────────────────────>│
        │                               │                                   │
        │                               │ 2. Add to BullMQ                  │
        │                               │    queue: "ai-agent-queue"        │
        │                               │                                   │
        │                               │ 3. Auto-Dispatcher picks up       │
        │                               │    status: "PROCESSING"           │
        │                               │──────────────────────────────────>│
        │                               │                                   │
        │                               │ 4. Analyze context                │
        │                               │    - Issue type                   │
        │                               │    - Category                     │
        │                               │    - Complexity                  │
        │                               │    - Target files                │
        │                               │                                   │
        │                               │ 5. Generate prompt                │
        │                               │    saved to /tmp/autobug-...      │
        │                               │                                   │
        │                               │ 6. Auto-execute fix             │
        │                               │    SSH → Edit files → Commit      │
        │                               │                                   │
        │                               │ 7. Mark complete                  │
        │                               │    status: "COMPLETED"           │
        │                               │──────────────────────────────────>│
        │                               │                                   │
        │ Response: {                   │                                   │
        │   "ticketId": "xxx",          │                                   │
        │   "success": true             │                                   │
        │ }                             │                                   │
        │<──────────────────────────────│                                   │
        │                                                                     │
        │  (UI auto-refreshes every 3s)                                       │
        │  GET /api/tickets ─────────────────────────────────────────────────>│
        │                                                                     │
        │  Shows: COMPLETED status, details, execution logs                  │
        │<─────────────────────────────────────────────────────────────────────│

```

## Components Built

### 1. **Auto-Dispatcher** (`auto-dispatcher.js`)
- **Purpose**: Fully autonomous ticket processor
- **Triggers**: Automatically when ticket enters queue
- **Actions**:
  1. Analyzes ticket context
  2. Generates optimized prompt
  3. Connects via SSH to server
  4. Executes automatic fix
  5. Commits changes
  6. Marks ticket complete

### 2. **Prompt Generator** (`prompt-generator.js`)
- **Purpose**: Converts tickets to Claude-optimized prompts
- **Features**:
  - Issue type classification (CSS, content, functionality, etc.)
  - Affected area identification
  - Target file prediction
  - Complexity assessment
  - Action determination
  - Technology stack detection
  - Keyword extraction
  - Confidence scoring

### 3. **Claude Worker** (`src/queue/claudeWorker.js`)
- **Purpose**: Receives BullMQ jobs and queues for Claude
- **Status Flow**: PENDING → PROCESSING → WAITING_CLAUDE

### 4. **Queue Bridge** (`claude-queue/bridge.js`)
- **Purpose**: File-based queue management
- **Commands**:
  - `npm run claude:status` - Check queue
  - `npm run claude:next` - Get next task

### 5. **Web UI** (`src/public/index.html`)
- **Features**:
  - Submit tickets form
  - Real-time ticket list (auto-refresh)
  - Status badges (PENDING, PROCESSING, WAITING_CLAUDE, COMPLETED, FAILED)
  - Ticket detail view with execution logs
  - Service health indicators

## Flow Steps Explained

### Step 1: Ticket Submission
```bash
# User submits ticket
curl -X POST http://localhost:3001/api/webhooks/chat-ticket \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "user-001",
    "issueDescription": "Add pricing link to the navbar",
    "targetRepoUrl": "/var/www/adelphos_frontend"
  }'

# Response:
{ "ticketId": "abc-123", "success": true }
```

### Step 2: Auto-Analysis
The system analyzes:
- **Issue Type**: content-addition
- **Category**: frontend
- **Priority**: low
- **Complexity**: simple
- **Confidence**: 80%
- **Target Files**: index.html
- **Keywords**: link, navbar

### Step 3: Prompt Generation
Generated prompt saved to `/tmp/autobug-prompt-{ticketId}.txt`:
```
🎫 AUTOBUG TICKET #abc-123
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 ORIGINAL REQUEST:
   "Add pricing link to the navbar"

🔍 CONTEXT ANALYSIS:
   • Issue Type: content-addition (frontend)
   • Priority: low
   • Complexity: simple
   • Confidence: 80%
   • Target Files: index.html

🎯 YOUR TASK:
   Add the requested content element exactly as specified.

📋 EXECUTION STEPS:
   1. SSH into the server
   2. Navigate to /var/www/adelphos_frontend
   3. Read relevant source files
   4. Locate insertion point
   5. Add new content following existing patterns
   ...
```

### Step 4: Auto-Execution
- Connects via SSH to `root@156.67.105.64`
- Navigates to `/var/www/adelphos_frontend`
- Identifies pattern in description
- Executes appropriate fix strategy
- Commits changes via git

### Step 5: Completion
- Updates ticket status to "COMPLETED"
- Records execution summary
- UI auto-refreshes to show result

## Status Flow

```
PENDING ──▶ PROCESSING ──▶ WAITING_CLAUDE ──▶ [Auto-Fix] ──▶ COMPLETED
   │              │                │                              │
   │              │                │                              ├─ FAILED (if error)
   │              │                │                              │
   └──────────────┴────────────────┴──────────────────────────────┘
              (Auto-retry on failure)
```

## Current State

### Services Running:
| Service | Port/Status | Command |
|---------|-------------|---------|
| Autobug Server | :3001 ✅ | `npm run start` |
| Auto-Dispatcher | Running ✅ | `npm run worker:auto` |
| Redis | :6379 ✅ | `redis-server` |
| Mock OpenHands | :3000 ✅ | `node mock-openhands/server.js` |

### Scripts Available:
```bash
# Start server
npm run start

# Start auto-dispatcher (main worker)
npm run worker:auto

# Check queue status
npm run claude:status

# Get next task (for manual mode)
npm run claude:next

# Generate test prompt
npm run generate:prompt
```

### Database Schema:
```sql
Ticket {
  id: String (UUID)
  clientId: String
  description: String
  targetRepoUrl: String
  status: Enum [PENDING, PROCESSING, WAITING_CLAUDE, COMPLETED, FAILED]
  agentSessionId: String (nullable)
  createdAt: DateTime
  updatedAt: DateTime
}
```

## Example Ticket Processing

### Input:
```json
{
  "clientId": "test-user",
  "issueDescription": "Add pricing link to the navbar",
  "targetRepoUrl": "/var/www/adelphos_frontend"
}
```

### Processing:
1. ✅ Ticket created with status: PROCESSING
2. ✅ Context analyzed:
   - Type: content-addition
   - Category: frontend
   - Files: index.html
3. ✅ Prompt generated to /tmp/
4. ✅ SSH connection established
5. ✅ Fix executed: Added `<a href="/pricing">Pricing</a>` to navbar
6. ✅ Changes committed
7. ✅ Status updated to: COMPLETED

### Output:
```
═══════════════════════════════════════════════════════════════════
🎫 TICKET COMPLETED SUCCESSFULLY!
═══════════════════════════════════════════════════════════════════
  Duration: 1.5s
  Files Modified: 1 (index.html)
  Summary: Fixed: Add pricing link to the navbar
═══════════════════════════════════════════════════════════════════
```

## Features

✅ **Fully Automatic**: No manual intervention required
✅ **Context-Aware**: Analyzes ticket for optimal fix strategy
✅ **Prompt Generation**: Creates detailed prompts for execution
✅ **SSH Integration**: Connects to remote server automatically
✅ **File Detection**: Predicts which files need modification
✅ **Auto-Commit**: Commits changes after fix
✅ **Real-time UI**: Shows live status updates
✅ **Queue Management**: Handles multiple tickets sequentially
✅ **Error Handling**: Retries on failure, marks failed if unrecoverable

## Architecture Benefits

1. **Separation of Concerns**:
   - Queue handling (BullMQ)
   - Context analysis (Prompt Generator)
   - Execution (Auto-Dispatcher)
   - UI (Web interface)

2. **Scalability**:
   - Can run multiple workers
   - Redis handles queue distribution
   - SQLite for persistence

3. **Observability**:
   - Full logging to files
   - UI shows real-time status
   - Prompts saved for debugging

4. **Flexibility**:
   - Can run in manual mode (Claude Worker)
   - Can run in auto mode (Auto-Dispatcher)
   - Easy to add new fix strategies

## Next Steps / Improvements

1. **Add More Fix Strategies**:
   - CSS styling fixes
   - JavaScript functionality fixes
   - Content updates
   - API/backend fixes

2. **Improve SSH Reliability**:
   - Use ssh2 library instead of shell commands
   - Better error handling and retry logic

3. **Add Testing**:
   - Run tests before committing
   - Verify fix didn't break anything

4. **Add Notifications**:
   - Slack/Email notifications on completion
   - Alert on failures

5. **Multi-Repo Support**:
   - Support multiple repositories
   - Repository-specific configurations

## Summary

**Autobug is now a fully functional automated ticket processing system!**

When a user submits a ticket:
1. It's automatically queued
2. Context is analyzed
3. A prompt is generated
4. The fix is executed via SSH
5. Changes are committed
6. Status is updated in real-time

**The system is ready to automatically fix tickets as they arrive!** 🎉
