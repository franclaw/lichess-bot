function throwError(msg) {
  throw new Error(msg);
}

module.exports = {
  accessToken: process.env.LICHESS_TOKEN || throwError('LICHESS_TOKEN is mandatory in env'),
  aiEndpoint: process.env.AI_ENDPOINT || 'http://localhost:1234/v1',
  model: process.env.AI_MODEL || undefined,
  temperature: process.env.AI_TEMPERATURE || '1',
  reasoningEffort: process.env.REASONING_EFFORT || 'medium',
  reasoningTokens: process.env.REASONING_TOKENS || '408',
  maxTokens: process.env.MAX_TOKENS || '512',
  username: process.env.BOT_USERNAME || 'boscodebot',
  autoAcceptChallenges: process.env.AUTO_ACCEPT_CHALLENGES !== 'false',
  gameAllowlist: process.env.GAME_ALLOWLIST || '',
  gameBlocklist: process.env.GAME_BLOCKLIST || ''
};
