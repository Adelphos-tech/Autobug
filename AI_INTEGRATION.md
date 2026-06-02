# AI Bug Solving Integration

## Current State: Mock Simulation
Right now, Autobug uses a **mock OpenHands server** that simulates AI responses but doesn't actually solve bugs.

## How Real AI Bug Solving Works

### Option 1: OpenHands (Full Autonomous Agent)
```
Ticket → Worker → OpenHands → AI Agent → GitHub Repo → Fix
```

OpenHands:
- Clones the repository
- Analyzes the codebase structure
- Reads relevant files
- Makes code changes
- Runs tests
- Commits and pushes fixes

### Option 2: Direct Claude API Integration
```
Ticket → Worker → Claude API → Code Changes → Git Apply → Repo
```

This is simpler and faster to set up.

## Implementation Approaches

### Approach A: SSH + Claude Direct

1. **Worker connects via SSH** to your server (156.67.105.64)
2. **Reads files** from `/var/www/adelphos_frontend`
3. **Sends to Claude API** with context
4. **Applies changes** directly to files
5. **Commits and pushes**

### Approach B: Local Git Clone + Claude

1. **Worker clones** repo to local workspace
2. **Analyzes codebase**
3. **Calls Claude API** for fixes
4. **Commits changes**
5. **Pushes back**

## What Would You Need?

### For Real AI Solving:

1. **Anthropic API Key** (for Claude)
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

2. **SSH Access** to your server (already configured)

3. **Git credentials** for committing changes

4. **Code analysis tools**:
   - File structure scanner
   - Code parser for context
   - Test runner

## Example: Direct Claude Integration

```javascript
// Simplified worker with Claude integration
const { Anthropic } = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function solveBug(ticket) {
  // 1. Read relevant files from repo
  const files = await readRepoFiles('/var/www/adelphos_frontend');
  
  // 2. Send to Claude with bug description
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    messages: [{
      role: 'user',
      content: `Fix this bug: ${ticket.description}\n\nFiles:\n${files}`
    }]
  });
  
  // 3. Apply the fix
  await applyChanges(response.content);
  
  // 4. Commit and push
  await gitCommitAndPush();
}
```

## Security Considerations

⚠️ **WARNING**: Running AI-generated code automatically is risky:
- AI could introduce security vulnerabilities
- Could delete important files
- Might break production code

### Recommended Safeguards:
1. **Dry-run mode**: Show changes before applying
2. **Review required**: Human approval before committing
3. **Branch protection**: AI works on feature branches
4. **Backup**: Always backup before auto-applying

## Next Steps

Would you like me to:

1. **Install real OpenHands** (requires Python 3.12 upgrade)
2. **Create direct Claude integration** (requires API key)
3. **Keep mock mode** for testing UI/workflow
4. **Create a hybrid**: Mock for UI, real AI for specific commands

## Current Mock Behavior

The mock server simulates:
- ✅ Ticket creation
- ✅ Queue processing
- ✅ Status updates
- ❌ Actual code changes (fake)
- ❌ Real git operations

To see it in action, submit a ticket in the UI and watch the simulated "AI agent" run through its steps.
