# Groq Integration - PRIMARY Context Provider

**Groq is now the PRIMARY system for context understanding and prompt creation.**

## Architecture

```
User Ticket → Groq (PRIMARY Context + Prompt) → Claude Code (Execution) → Result
                  ↓                                        ↓
           ALWAYS tries first                   ALWAYS executes code
           Creates enhanced prompt              SSH to server
           Falls back on failure                Applies fixes
```

## What's Primary vs Fallback

| Task | Primary | Fallback |
|------|---------|----------|
| **Context Analysis** | Groq API | Local pattern matching |
| **Prompt Creation** | Groq generates enhanced prompt | Local prompt generator |
| **Code Execution** | Claude Code (always) | N/A |
| **Fix Application** | Claude via SSH (always) | N/A |

## Configuration

```bash
# .env - Groq is ENABLED by default
GROQ_ENABLED=true                          # Enable Groq as PRIMARY
GROQ_API_KEY=gsk_your_key_here             # Required
GROQ_MODEL=llama-3.3-70b-versatile         # Fast context model
GROQ_TIMEOUT_MS=30000                      # 30 second timeout
GROQ_FALLBACK_ON_ERROR=true                # Fallback to local if Groq fails
```

## Flow

### Step 1: Groq Context Analysis (PRIMARY)

```javascript
// Groq ALWAYS analyzes first (unless disabled):
{
  userIntent: "Standardize back button styling",
  affectedElements: ["back-button", "navbar"],
  technicalTerms: [".back-btn", "background-color"],
  filesToCheck: ["src/components/Button.css", "src/styles/theme.css"],
  clarifiedDescription: "Update .back-btn to match primary button styles",
  confidence: 0.87
}
```

**If Groq succeeds:** Use Groq context for everything  
**If Groq fails:** Automatically fallback to local analysis

### Step 2: Groq Prompt Generation (PRIMARY)

```javascript
// Groq creates the complete prompt structure:
{
  technicalRequirements: [
    "Find .back-btn CSS class definition",
    "Identify primary button color",
    "Update background-color property",
    "Verify contrast accessibility"
  ],
  suggestedApproach: "Search for button styles, compare, update CSS",
  claudePrompt: "Find the .back-btn class... Compare with .btn-primary...",
  filesHint: ["src/components/Button.css", "src/styles/theme.css"],
  validationCriteria: ["Button color matches primary", "Good contrast"]
}
```

**If Groq succeeds:** Use Groq-generated prompt  
**If Groq fails:** Use local prompt generator

### Step 3: Claude Code Execution (ALWAYS)

```
Claude receives:
- Groq's enhanced prompt (or local fallback)
- Technical requirements
- File suggestions
- Validation criteria

Claude executes via SSH:
- Reads files
- Makes changes
- Verifies fixes
```

## Console Output

When Groq is PRIMARY, you'll see:

```
🤖 STEP 2a: Groq analyzing context (PRIMARY)...
   🤖 Context analyzed by: llama-3.3-70b-versatile
   User Intent: Standardize back button styling
   Affected Elements: back-button, navbar
   Technical Terms: .back-btn, background-color, primary
   Confidence: 87%

📝 STEP 3: Generating optimized prompt...
   🤖 PRIMARY: Groq generating enhanced prompt for Claude...
   ✅ Prompt created by Groq (PRIMARY)
   • Technical Requirements: 4
   • Files Hinted: 2
   • Validation Criteria: 3
```

If Groq fails and falls back:

```
🤖 STEP 2a: Groq analyzing context (PRIMARY)...
   ⚠️ Groq context analysis failed: timeout
   ⚙️  Falling back to local analysis...

📝 STEP 3: Generating optimized prompt...
   ⚙️  Prompt generated locally
```

## Disabling Groq

To use local analysis only:

```bash
GROQ_ENABLED=false
```

Or to fail fast without fallback:

```bash
GROQ_ENABLED=true
GROQ_FALLBACK_ON_ERROR=false   # Tickets will FAIL if Groq errors
```

## Execution Log

```json
{
  "ticketId": "abc-123",
  "contextProvider": "groq",        // PRIMARY used Groq
  "codeExecutor": "claude-code",    // Claude always executes
  "groqModel": "llama-3.3-70b-versatile",
  "groqContext": {
    "userIntent": "...",
    "confidence": 0.87
  },
  "promptSource": "groq-primary",   // groq-primary | local-fallback
  "enhancedByGroq": true,
  "usedLocalAnalysis": false
}
```

## Cost

- **Groq**: ~$0.0001-0.0005 per request (context + prompt)
- **Claude**: Only used for actual code execution
- **Savings**: Groq is 10-50x cheaper than Claude for context tasks

## API Key

Get your API key from: https://console.groq.com

Free $5 starter credit available.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Groq timeout | Increase `GROQ_TIMEOUT_MS` |
| Low confidence | Check `ambiguities` in logs |
| API errors | Verify `GROQ_API_KEY` is set |
| Want local only | Set `GROQ_ENABLED=false` |

## Summary

- ✅ Groq is PRIMARY for context understanding
- ✅ Groq is PRIMARY for prompt generation  
- ✅ Claude Code ALWAYS does the actual coding
- ✅ Automatic fallback if Groq fails
- ✅ Configurable via environment variables
