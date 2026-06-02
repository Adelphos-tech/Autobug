# Autobug Safety Guide

## Overview

The Safe Auto-Dispatcher includes comprehensive validation and safety checks to ensure **no wrong context reaches Claude Code**.

## Safety Layers

### Layer 1: Ticket Validation (Before Processing)

Every ticket goes through 8 validation checks:

| Check | Purpose | Auto-Block If |
|-------|---------|---------------|
| **Description Quality** | Ensure clear instructions | Empty, too short, or vague |
| **Forbidden Keywords** | Prevent dangerous operations | Contains "database", "api", "production" |
| **Confidence Level** | Ensure we understand the task | Below 75% confidence |
| **Complexity Check** | Stay within safe bounds | Complexity > "medium" |
| **Issue Type** | Only process known-safe types | Unknown or dangerous issue types |
| **Target Files** | Avoid sensitive files | Targeting config, .env, package.json |
| **Repository Access** | Whitelist check | Unknown repository |
| **Safety Patterns** | Block destructive commands | Contains "delete all", "drop", etc. |

### Layer 2: Command Whitelist

Only these commands are allowed to execute:

**✅ SAFE - Read Commands:**
- `cat`, `ls`, `find`, `grep`, `head`, `tail`, `pwd`, `cd`

**✅ SAFE - Write Commands (Limited):**
- `sed -i` only on `index.html`

**✅ SAFE - Git Commands:**
- `git add`, `git status`, `git log`, `git diff`
- `git commit` (requires confirmation)

**✅ SAFE - Temp Files:**
- `echo`/`printf` to `/tmp/`
- `rm -f /tmp/...`

**❌ BLOCKED - Dangerous Commands:**
- `rm -rf`, `rm *` (mass deletion)
- `dd if=` (disk operations)
- `> /etc/` (system files)
- `mkfs` (filesystem)
- `curl | sh` (remote execution)
- `chmod 777` (dangerous permissions)
- `sudo`, `su -` (privilege escalation)

### Layer 3: Execution Modes

#### Mode 1: DRY RUN (Default)
```bash
npm run worker:safe:dry
```n- Analyzes tickets
- Generates prompts
- Creates execution plans
- **Does NOT make any changes**
- Shows what would be done

#### Mode 2: LIVE (With Confirmation)
```bash
REQUIRE_CONFIRMATION=true npm run worker:safe
```
- Validates tickets
- Shows warnings
- **Waits for confirmation before executing**
- Safe for production

#### Mode 3: AUTO (No Confirmation)
```bash
REQUIRE_CONFIRMATION=false npm run worker:safe
```
- Full automation
- Only processes tickets with no warnings
- Requires high confidence (>85%)

## Forbidden Keywords

These keywords in a ticket description will **block auto-processing**:

- `database`, `db` - Database operations
- `server`, `api`, `endpoint` - Backend changes
- `production`, `prod`, `live` - Production environment
- `critical`, `security`, `auth` - Security-related
- `password`, `token`, `secret` - Sensitive data
- `delete all`, `drop`, `remove all` - Mass deletion
- `refactor`, `rewrite`, `restructure` - Major changes

## Confidence Thresholds

| Confidence | Action |
|------------|--------|
| < 70% | ❌ Blocked - Manual review required |
| 70-85% | ⚠️  Allowed with warning - Review recommended |
| > 85% | ✅ Auto-process allowed |

## Ticket Status Flow

```
SUBMITTED
    ↓
[VALIDATION]
    ↓
    ├─► INVALID ─────► REJECTED ❌
    │   (has errors)
    │
    ├─► VALID but ───► WAITING_CLAUDE 👤
    │   needs review    (manual processing)
    │
    └─► VALID and ───► AUTO-PROCESSING 🤖
        safe            → COMPLETED ✅
                        → FAILED ❌
```

## Validation Results

Every validation is saved to `logs/validation-{ticketId}.json`:

```json
{
  "ticketId": "...",
  "isValid": true,
  "canAutoProcess": true,
  "requiresManualReview": false,
  "warnings": ["Confidence moderate (80%)"],
  "errors": [],
  "checks": {
    "descriptionQuality": { "passed": true },
    "forbiddenKeywords": { "passed": true },
    "confidenceLevel": { "passed": true },
    "complexity": { "passed": true },
    "issueType": { "passed": true },
    "targetFiles": { "passed": true },
    "repositoryAccess": { "passed": true },
    "safetyPatterns": { "passed": true }
  },
  "recommendation": {
    "action": "AUTO_PROCESS",
    "message": "Ticket is safe for automatic processing"
  }
}
```

## Example Safe Tickets

### ✅ SAFE - Will Auto-Process

```json
{
  "description": "Add pricing link to the navbar",
  "confidence": 0.80,
  "complexity": "simple",
  "issueType": "content-addition"
}
```

**Result**: AUTO_PROCESS ✅

### ⚠️  SAFE with Warnings

```json
{
  "description": "Fix the thing on the page",
  "confidence": 0.75,
  "complexity": "simple",
  "issueType": "general"
}
```

**Result**: AUTO_PROCESS with warnings ⚠️
- Warning: "Description lacks specific technical terms"
- Warning: "Confidence moderate (75%)"

### ❌ BLOCKED - Manual Review

```json
{
  "description": "Fix database connection error",
  "confidence": 0.60,
  "complexity": "complex",
  "issueType": "backend-issue"
}
```

**Result**: WAITING_CLAUDE 👤
- Error: "Contains forbidden keyword: database"
- Error: "Confidence too low (60%). Minimum: 70%"
- Error: "Complexity too high: complex"

### ❌ REJECTED

```json
{
  "description": "Delete all files",
  "confidence": 0.90,
  "complexity": "simple"
}
```

**Result**: FAILED ❌
- Error: "Contains destructive pattern: Potential mass deletion"

## Commands

### Start in Safe Mode

```bash
# Dry run - no changes made
npm run worker:safe:dry

# Live with confirmation
npm run worker:safe

# Full auto (only safe tickets)
REQUIRE_CONFIRMATION=false npm run worker:safe
```

### Test Validation

```bash
# Run validation tests
npm run test:validation

# Check a specific ticket's validation
cat logs/validation-{ticketId}.json

# View all logs
npm run logs
```

## Logs

All activity is logged to the `logs/` directory:

| File | Content |
|------|---------|
| `validation-{id}.json` | Validation results |
| `prompt-{id}.txt` | Generated prompt |
| `execution-{id}.json` | Execution results |
| `safe-dispatcher.log` | Runtime logs |

## Best Practices

### 1. Always Start in DRY RUN
Test new ticket types in dry-run mode first.

### 2. Review Warnings
Even if auto-processing is allowed, review warnings.

### 3. Check Validation Files
Before enabling live mode, check validation results.

### 4. Start Conservative
Use high confidence thresholds initially:
```bash
MIN_CONFIDENCE=0.85 npm run worker:safe
```

### 5. Monitor Logs
Watch the logs directory for issues:
```bash
tail -f logs/safe-dispatcher.log
```

## Troubleshooting

### Ticket Keeps Getting Rejected

Check the validation file:
```bash
cat logs/validation-{ticketId}.json | jq '.errors'
```

### Safe Commands Blocked

Add the command pattern to `SAFE_COMMANDS` in `safe-auto-dispatcher.js`.

### False Positives

Adjust validation thresholds:
- Lower `MIN_CONFIDENCE` in `.env`
- Modify `FORBIDDEN_KEYWORDS` list
- Update `SAFE_ISSUE_TYPES`

## Configuration

Create `.env` file:

```bash
# Safety Settings
DRY_RUN=true                    # Start with true
REQUIRE_CONFIRMATION=true       # Always confirm
MIN_CONFIDENCE=0.75            # 75% minimum
MAX_COMPLEXITY=medium         # medium or simple only

# SSH Settings
SSH_HOST=156.67.105.64
SSH_USER=root
SSH_PASSWORD=your-password
DEFAULT_REPO_PATH=/var/www/adelphos_frontend
```

## Summary

The Safe Auto-Dispatcher ensures:

✅ **No wrong context** - Comprehensive validation  
✅ **No dangerous commands** - Command whitelist  
✅ **No blind execution** - Multiple safety modes  
✅ **Full audit trail** - Detailed logging  
✅ **Gradual rollout** - Dry-run to live  

**Only tickets that pass ALL validation checks will be auto-processed!**
