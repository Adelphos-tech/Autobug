#!/bin/bash
# Remote fix script - run on the server

REPO_PATH="/var/www/adelphos_frontend"
LINK_TEXT="$1"
LINK_HREF="$2"

if [ -z "$LINK_TEXT" ] || [ -z "$LINK_HREF" ]; then
    echo "Usage: $0 <link_text> <link_href>"
    exit 1
fi

# Find line number of "AI Training"
LINE_NUM=$(grep -n "AI Training" "$REPO_PATH/index.html" | head -1 | cut -d: -f1)

if [ -z "$LINE_NUM" ]; then
    echo "Error: Could not find AI Training line"
    exit 1
fi

# Create new content
echo "Adding $LINK_TEXT link after line $LINE_NUM"

# Build new file
head -n "$LINE_NUM" "$REPO_PATH/index.html" > /tmp/new_index.html
echo "      <a href=\"$LINK_HREF\">$LINK_TEXT</a>" >> /tmp/new_index.html
tail -n +$((LINE_NUM + 1)) "$REPO_PATH/index.html" >> /tmp/new_index.html

# Replace original
mv /tmp/new_index.html "$REPO_PATH/index.html"

echo "Successfully added $LINK_TEXT link"
