#!/bin/bash
# Remote removal script - run on the server

REPO_PATH="/var/www/adelphos_frontend"
LINK_TEXT="$1"

if [ -z "$LINK_TEXT" ]; then
    echo "Usage: $0 <link_text>"
    exit 1
fi

# Check if the link exists
if ! grep -q "${LINK_TEXT}" "$REPO_PATH/index.html"; then
    echo "Link not found"
    exit 0
fi

# Remove the line containing the link (matches <a...>LinkText</a>)
sed -i "/<a[^>]*>${LINK_TEXT}<\/a>/d" "$REPO_PATH/index.html"

echo "Successfully removed ${LINK_TEXT} link"
