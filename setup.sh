#!/bin/bash

echo "=== Lichess AI Bot Setup ==="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "✅ Node.js found: $(node --version)"
echo ""

# Create config file if it doesn't exist
if [ ! -f config.cjs ]; then
    echo "Creating config.cjs..."
    
    read -p "Enter your Lichess access token (get from https://lichess.org/account/oauth/token/create): " token
    
    if [ -z "$token" ]; then
        echo "❌ Token is required. Exiting."
        exit 1
    fi
    
    read -p "Enter your bot's username: " username
    
    if [ -z "$username" ]; then
        echo "❌ Username is required. Exiting."
        exit 1
    fi
    
    read -p "Enter your AI endpoint (default: http://localhost:1234/v1): " ai_endpoint
    ai_endpoint=${ai_endpoint:-http://localhost:1234/v1}
    
    read -p "Enter your AI model name (optional, e.g., lmstudio/qwen/qwen3-coder-next): " ai_model
    
    cat > config.cjs << CONFIG_EOF
module.exports = {
  accessToken: '$token',
  aiEndpoint: '$ai_endpoint',
  model: '$ai_model',
  username: '$username'
};
CONFIG_EOF

    echo ""
    echo "✅ Config saved to config.cjs"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the bot:"
echo "  cd lichess-bot && node index.cjs"
echo ""
echo "The bot will:"
echo "  - Listen for Lichess game events"
echo "  - Watch games where your bot is playing"
echo "  - Ask the local AI model to make moves"
echo ""
echo "Don't forget to start your local AI server on port 1234!"
