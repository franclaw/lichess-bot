const fs = require('node:fs');

function parseEnvFile() {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function getEnvValue(key, fallback) {
  const envFile = parseEnvFile();
  if (Object.prototype.hasOwnProperty.call(envFile, key) && envFile[key] !== '') return envFile[key];
  return fallback;
}

function throwError(msg) {
  throw new Error(msg);
}

module.exports = {
  accessToken: getEnvValue('LICHESS_TOKEN', null) || throwError('LICHESS_TOKEN is mandatory in .env'),
  aiEndpoint: getEnvValue('AI_ENDPOINT', 'http://localhost:1234/v1'),
  model: getEnvValue('AI_MODEL', undefined) || undefined,
  temperature: getEnvValue('AI_TEMPERATURE', '1'),
  reasoningEffort: getEnvValue('REASONING_EFFORT', 'medium'),
  reasoningTokens: getEnvValue('REASONING_TOKENS', '408'),
  maxTokens: getEnvValue('MAX_TOKENS', '512'),
  username: getEnvValue('BOT_USERNAME', 'boscodebot'),
  autoAcceptChallenges: getEnvValue('AUTO_ACCEPT_CHALLENGES', 'true') !== 'false',
  gameAllowlist: getEnvValue('GAME_ALLOWLIST', ''),
  gameBlocklist: getEnvValue('GAME_BLOCKLIST', '')
};
