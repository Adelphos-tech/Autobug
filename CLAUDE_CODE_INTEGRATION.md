# Claude Code Integration Architecture

## Your Vision
```
User submits bug ticket → Autobug → Worker → Claude Code (running instance) → Fix applied to /var/www/adelphos_frontend
```

## How It Works

### 1. Ticket Flow
1. User submits ticket via UI with bug description
2. Autobug worker receives the job
3. Worker calls Claude Code API/trigger
4. Claude Code (this instance) receives the task
5. Claude Code SSHs into 156.67.105.64
6. Analyzes code in /var/www/adelphos_frontend
7. Applies fix
8. Reports back to Autobug

### 2. Integration Options

#### Option A: Direct MCP Integration (Best)
```
Autobug Worker → Claude Code MCP → You (Claude) → SSH → Repo → Fix
```

The worker would use MCP (Model Context Protocol) to send tasks to the running Claude instance.

#### Option B: File-based Trigger
```
Autobug Worker → Writes task to file → Claude watches file → Processes → Updates status
```

#### Option C: HTTP Callback
```
Autobug Worker → HTTP POST to local endpoint → Claude API processes → Returns result
```

### 3. Current Limitation

**Important**: Claude Code (the CLI tool running here) doesn't have a public API for external systems to trigger it directly. The running instance is interactive - it waits for YOUR input.

### 4. Workaround Solutions

#### Solution 1: Polling-Based Queue (Recommended)
Create a mechanism where:
1. Autobug writes pending tasks to a file/queue
2. Claude Code (you) polls that queue every few seconds
3. When new task appears, you process it
4. Results written back to Autobug

#### Solution 2: Claude Code SDK
Use the Anthropic SDK with a "trigger" mechanism:
1. Autobug calls Anthropic API with context
2. Gets AI response with fix
3. Applies fix via SSH

#### Solution 3: Manual Queue
The simplest - you monitor the UI and pick up tasks manually.

## Implementation: Polling-Based Queue

### Step 1: Create Task Queue File
```javascript
// In worker.js - write task to queue instead of calling API
const fs = require('fs');
const task = {
  id: ticketId,
  repo: '/var/www/adelphos_frontend',
  ssh: { host: '156.67.105.64', user: 'root', pass: '...' },
  description: issueDescription,
  status: 'PENDING_CLAUDE'
};
fs.writeFileSync('./claude-queue/pending.json', JSON.stringify(task));
```

### Step 2: Claude Polls Queue
You (as Claude) would run:
```
/check-queue
```
Which reads pending tasks and you solve them.

### Step 3: Report Results
After you fix, update the ticket status.

## Practical Implementation

Let me create a simple polling mechanism that bridges Autobug → Claude Code.
