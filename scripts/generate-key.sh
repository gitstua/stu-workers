#!/bin/bash

# This is a wrapper script for the generate-api-key.js script
# It prompts for the expiry date and runs the Node.js script with the expiry date

set -e  # Exit on error

echo "API Key Generator"
echo "----------------"


echo checking node is installed
if ! command -v node &> /dev/null; then
    echo "node could not be found"
    exit 1
fi



# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "Error: .env file not found"
    exit 1
fi

# Prompt for the expiry date
default_expiry=$(date -v+1m +%Y-%m-%d 2>/dev/null || date -d "+1 month" +%Y-%m-%d)

read -p "Enter the expiry date (YYYY-MM-DD, default: $default_expiry): " expiry
if [ -z "$expiry" ]; then
    echo "No expiry date provided, using default: $default_expiry"
    expiry=$default_expiry
fi

read -p "Enter a poll ID to scope this key (optional): " resource
if [ -n "$resource" ]; then
    echo "Scoping key to resource: $resource"
fi

echo "Generating key..."

# Run the Node.js script with the expiry date
DOTENV_CONFIG_PATH=".env" \
key=$(node -r dotenv/config scripts/generate-api-key.js "$expiry" "$resource")

echo ""
echo "Generated key: $key"
if [ -n "$resource" ]; then
  echo "Scoped to questionId: $resource"
  echo "Use header: X-API-Key: $key"
  echo "Question SPA:   https://stu-workers.stuey.workers.dev/poll/app?id=$resource"
  echo "Admin SPA:  https://stu-workers.stuey.workers.dev/poll/admin/spa?key=$key"
else
  echo "Unscoped key (all questions):"
  echo "Use header: X-API-Key: $key"
  echo "Admin SPA:  https://stu-workers.stuey.workers.dev/poll/admin/spa?key=$key"
fi
