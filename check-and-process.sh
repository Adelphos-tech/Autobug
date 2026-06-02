#!/bin/bash
# Check for pending tickets and output formatted data for Claude

cd "$(dirname "$0")"

# Check status
STATUS=$(npm run --silent claude:status 2>/dev/null)
PENDING=$(echo "$STATUS" | grep -o '"pending": [0-9]*' | cut -d' ' -f2)

if [ "$PENDING" -eq 0 ] 2>/dev/null; then
    echo "NO_TICKETS"
    exit 0
fi

# Get next task
npm run --silent claude:next 2>/dev/null
