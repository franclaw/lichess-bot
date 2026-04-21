const config = require('./config.cjs');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Chess } = require('chess.js');

const GAME_RUNTIME_CONFIG_FILE = '.game-runtime-config.json';

class LichessBot {
  constructor() {
    this.apiBase = 'https://lichess.org/api';
    this.headers = { 
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json'
    };
    this.myBotUsername = config.username.toLowerCase();
    this.aiEndpoint = config.aiEndpoint;
    this.aiModel = config.model || '';
    this.autoAcceptChallenges = config.autoAcceptChallenges !== false;
    this.gameAllowlist = this.parseGameIdList(config.gameAllowlist);
    this.gameBlocklist = this.parseGameIdList(config.gameBlocklist);
    this.activeGames = new Map();
    this.gameRuntimeConfig = new Map();
    this.gameChatIntroSent = new Set();
    this.pendingChallenges = new Set();
  }

  async init() {
    // Fetch free models from OpenRouter at startup
    this.freeModelList = await this.fetchFreeModelsList();
    const runtimeConfig = this.loadRuntimeConfig();
    console.log('Initializing bot...');
    console.log(`AI Endpoint: ${runtimeConfig.aiEndpoint}`);
    console.log(`AI model for new games: ${runtimeConfig.model}`);
    console.log(`My username: ${this.myBotUsername}\n`);

    const gameIds = process.argv.slice(2).filter(Boolean);
    if (gameIds.length) {
      gameIds.forEach((id) => this.startGame({ id }));
      await Promise.all(this.activeGames.values());
      return;
    }

    await this.resumeOngoingGames();
    await this.watchEvents();
  }

  async resumeOngoingGames() {
    try {
      console.log('Checking for ongoing games...');
      const data = await this.fetch(`${this.apiBase}/account/playing`);
      const games = Array.isArray(data.nowPlaying) ? data.nowPlaying : [];

      if (!games.length) {
        console.log('No ongoing games found');
        return;
      }

      console.log(`Found ${games.length} ongoing game${games.length === 1 ? '' : 's'}`);
      for (const game of games) {
        const gameId = game.gameId || game.id || game.fullId?.slice(0, 8);
        if (!gameId) {
          console.log('Skipping ongoing game without an id');
          continue;
        }

        this.startGame({
          id: gameId,
          color: game.color,
          lastMove: game.lastMove
        });
      }
    } catch (err) {
      console.error('Failed to resume ongoing games:', err.message);
    }
  }

  async watchEvents() {
    while (true) {
      try {
        console.log('Opening Lichess event stream...');
        const events = await this.fetchStream(`${this.apiBase}/stream/event`);

        for await (const line of events) {
          if (!line) continue;

          try {
            const event = JSON.parse(line);
            this.handleEvent(event).catch((err) => {
              console.error(`Event handler error (${event.type || 'unknown'}):`, err.message);
            });
          } catch (err) {
            console.error('Parse error:', err.message);
          }
        }
      } catch (err) {
        console.error('Event stream error:', err.message);
      }

      console.log('Event stream closed; reconnecting in 5s');
      await this.sleep(5000);
    }
  }

  async fetchStream(url, options = {}) {
    const response = await fetch(url, { ...options, headers: this.headers });

    if (response.status === 400) {
      console.error(`[HTTP 400] Stream error for ${url}; body=${await response.text().catch(() => '<empty>')}`);
      console.error(`[HTTP 400] Headers: ${JSON.stringify(this.headers)}`);
    }

    if (response.status === 429) {
      console.error(`[RATE LIMIT] Stream request got HTTP 429 for ${url}; retry-after=${response.headers.get('retry-after') || 'not provided'}`);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            yield line;
          }
        }
        
        if (buffer) yield buffer;
      }
    };
  }

  async handleEvent(event) {
    if (event.type === 'challenge') {
      await this.acceptChallenge(event.challenge);
      return;
    }

    if (event.type === 'gameStart') {
      this.startGame(event.game);
      return;
    }

    if (event.type === 'challengeCanceled' || event.type === 'challengeDeclined') {
      const challengeId = event.challenge?.id || 'unknown';
      this.pendingChallenges.delete(challengeId);
      console.log(`Challenge ${challengeId} ${event.type === 'challengeCanceled' ? 'canceled' : 'declined'}`);
    }
  }

  async acceptChallenge(challenge) {
    const challengeId = challenge?.id;
    if (!challengeId) return;

    if (!this.autoAcceptChallenges) {
      console.log(`Auto-accept disabled; ignoring challenge ${challengeId}`);
      return;
    }

    if (this.pendingChallenges.has(challengeId)) return;
    this.pendingChallenges.add(challengeId);

    const challenger = challenge.challenger?.name || challenge.challenger?.id || 'unknown';
    const variant = challenge.variant?.key || challenge.variant?.name || 'unknown';
    const speed = challenge.speed || 'unknown';
    const color = challenge.color || 'random';

    try {
      console.log(`Accepting challenge ${challengeId} from ${challenger} (${variant}, ${speed}, ${color})`);
      await this.fetch(`${this.apiBase}/challenge/${challengeId}/accept`, { method: 'POST' });
      console.log(`Challenge accepted: ${challengeId}`);
    } catch (err) {
      console.error(`Challenge accept failed (${challengeId}):`, err.message);
      this.pendingChallenges.delete(challengeId);
    }
  }

  startGame(gameInfo) {
    const gameId = gameInfo?.id;
    if (!gameId) return null;

    if (!this.shouldWatchGame(gameId)) {
      console.log(`[${gameId}] Skipping game due to allow/block list`);
      return null;
    }

    if (this.activeGames.has(gameId)) {
      console.log(`[${gameId}] Already watching game`);
      return this.activeGames.get(gameId);
    }

    const runtimeConfig = this.getOrCreateGameRuntimeConfig(gameId);
    this.gameRuntimeConfig.set(gameId, runtimeConfig);
    console.log(`[${gameId}] Runtime config locked: model=${runtimeConfig.model}, endpoint=${runtimeConfig.aiEndpoint}, temperature=${runtimeConfig.temperature}, reasoning_effort=${runtimeConfig.reasoningEffort}, reasoning_tokens=${runtimeConfig.reasoningTokens}, max_tokens=${runtimeConfig.maxTokens}`);

    console.log(`=== Watching game: ${gameId} ===`);
    const promise = this.watchGame(gameInfo)
      .catch((err) => {
        console.error(`[${gameId}] Watch error:`, err.message);
      })
      .finally(() => {
        this.activeGames.delete(gameId);
        this.gameRuntimeConfig.delete(gameId);
        this.gameChatIntroSent.delete(gameId);
        this.deleteStoredGameRuntimeConfig(gameId);
        console.log(`[${gameId}] Watcher stopped`);
      });

    this.activeGames.set(gameId, promise);
    return promise;
  }

  parseEnvFile() {
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

  getRuntimeEnvValue(envFile, key, fallback) {
    if (Object.prototype.hasOwnProperty.call(envFile, key) && envFile[key] !== '') return envFile[key];
    if (process.env[key]) return process.env[key];
    return fallback;
  }

  async fetchFreeModelsList() {
    const key = this.getRuntimeEnvValue(this.parseEnvFile(), 'AI_API_KEY', '');
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` }
      });
      if (!response.ok) return null;
      const data = await response.json();
      const freeModels = data.data
        .filter(m => m.pricing?.prompt === '0' && m.pricing?.completion === '0' && m.context_length > 1000)
        .map(m => m.id);
      console.log(`Loaded ${freeModels.length} free models from OpenRouter`);
      return freeModels;
    } catch (err) {
      console.error('Failed to fetch free models:', err.message);
      return null;
    }
  }

  loadRuntimeConfig() {
    const envFile = this.parseEnvFile();
    const endpoint = this.getRuntimeEnvValue(envFile, 'AI_ENDPOINT', config.aiEndpoint);
    const modelExplicitlySet = Object.prototype.hasOwnProperty.call(envFile, 'AI_MODEL') && envFile.AI_MODEL !== '';
    const modelFromEnv = this.getRuntimeEnvValue(envFile, 'AI_MODEL', config.model);
    const key = this.getRuntimeEnvValue(envFile, 'AI_API_KEY', '');

    let model;
    if (modelExplicitlySet) {
      model = modelFromEnv;
    } else if (this.freeModelList && this.freeModelList.length > 0) {
      model = this.freeModelList[Math.floor(Math.random() * this.freeModelList.length)];
    } else {
      throw new Error('AI_MODEL not set and free model selection failed.');
    }

    return {
      aiEndpoint: endpoint,
      model,
      temperature: this.parseRuntimeNumber(this.getRuntimeEnvValue(envFile, 'AI_TEMPERATURE', '1'), 1),
      reasoningEffort: this.getRuntimeEnvValue(envFile, 'REASONING_EFFORT', 'medium'),
      reasoningTokens: this.parseRuntimeNumber(this.getRuntimeEnvValue(envFile, 'REASONING_TOKENS', '408'), 408),
      maxTokens: this.parseRuntimeNumber(this.getRuntimeEnvValue(envFile, 'MAX_TOKENS', '512'), 512),
      feedbackRetries: this.parseRuntimeNumber(this.getRuntimeEnvValue(envFile, 'AI_FEEDBACK_RETRIES', '4'), 4),
      apiKey: key
    };
  }

  readStoredGameRuntimeConfigs() {
    try {
      return JSON.parse(fs.readFileSync(GAME_RUNTIME_CONFIG_FILE, 'utf8'));
    } catch {
      return {};
    }
  }

  writeStoredGameRuntimeConfigs(configs) {
    fs.writeFileSync(GAME_RUNTIME_CONFIG_FILE, `${JSON.stringify(configs, null, 2)}\n`);
  }

  getOrCreateGameRuntimeConfig(gameId) {
    const storedConfigs = this.readStoredGameRuntimeConfigs();
    let configChanged = false;

    if (storedConfigs[gameId]) {
      if (!storedConfigs[gameId].sessionId) {
        storedConfigs[gameId].sessionId = crypto.randomUUID();
        configChanged = true;
      }
    } else {
      const runtimeConfig = this.loadRuntimeConfig();
      storedConfigs[gameId] = {
        ...runtimeConfig,
        sessionId: crypto.randomUUID(),
        lockedAt: new Date().toISOString()
      };
      configChanged = true;
    }

    if (configChanged) {
      this.writeStoredGameRuntimeConfigs(storedConfigs);
    }
    return storedConfigs[gameId];
  }

  deleteStoredGameRuntimeConfig(gameId) {
    const storedConfigs = this.readStoredGameRuntimeConfigs();
    if (!storedConfigs[gameId]) return;

    delete storedConfigs[gameId];
    this.writeStoredGameRuntimeConfigs(storedConfigs);
  }

  async sendChatMessage(gameId, room, text) {
    try {
      await this.fetch(`${this.apiBase}/bot/game/${gameId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ room, text })
      });
    } catch (err) {
      console.error(`[${gameId}] Chat message failed:`, err.message);
    }
  }

  async sendChatLog(gameId, label, text, room = 'player') {
    const maxMessageLength = 140;
    const normalized = String(text || '').trim() || '<empty>';
    const prefix = `[${label}] `;
    const maxLength = Math.max(20, maxMessageLength - prefix.length - 8);
    const chunks = [];

    for (let index = 0; index < normalized.length; index += maxLength) {
      chunks.push(normalized.slice(index, index + maxLength));
    }

    for (let index = 0; index < chunks.length; index++) {
      const suffix = chunks.length > 1 ? `${index + 1}/${chunks.length} ` : '';
      await this.sendChatMessage(gameId, room, `${prefix}${suffix}${chunks[index]}`);
      if (chunks.length > 1) await this.sleep(500);
    }
  }

  async sendGameIntroChat(gameId, myColor) {
    if (this.gameChatIntroSent.has(gameId)) return;
    this.gameChatIntroSent.add(gameId);

    const runtimeConfig = this.gameRuntimeConfig.get(gameId) || this.loadRuntimeConfig();
    await this.sendChatLog(
      gameId,
      'model',
      `${runtimeConfig.model}; temp=${runtimeConfig.temperature}; effort=${runtimeConfig.reasoningEffort}; reasoning_tokens=${runtimeConfig.reasoningTokens}; max_tokens=${runtimeConfig.maxTokens}`
    );

  }

  parseRuntimeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  parseGameIdList(value) {
    return new Set(
      String(value || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
  }

  shouldWatchGame(gameId) {
    if (this.gameBlocklist.has(gameId)) return false;
    if (this.gameAllowlist.size > 0 && !this.gameAllowlist.has(gameId)) return false;
    return true;
  }

  normalizeUsername(value) {
    return String(value || '').trim().toLowerCase().replace(/^bot\s+/, '');
  }

  playerMatchesBot(player) {
    const user = player?.user || player || {};
    return [
      user.id,
      user.name,
      user.username
    ].some((value) => this.normalizeUsername(value) === this.myBotUsername);
  }

  getStatePayload(event) {
    return event.state || event;
  }

  getMoves(state, fallbackPosition) {
    if (typeof state.moves === 'string') return state.moves.trim();
    return fallbackPosition.trim();
  }

  getWhiteToMove(state, fen, moves) {
    if (typeof state.whiteToMove === 'boolean') return state.whiteToMove;

    const activeColor = fen?.split(/\s+/)[1];
    if (activeColor === 'w') return true;
    if (activeColor === 'b') return false;

    const moveCount = moves ? moves.split(/\s+/).filter(Boolean).length : 0;
    return moveCount % 2 === 0;
  }

  inferMyColor(gameInfo, event) {
    const eventColor = this.normalizeUsername(gameInfo.color);
    if (eventColor === 'white' || eventColor === 'black') return eventColor;

    if (this.playerMatchesBot(event.white || event.players?.white)) return 'white';
    if (this.playerMatchesBot(event.black || event.players?.black)) return 'black';

    return null;
  }

  moveToUci(move) {
    return `${move.from}${move.to}${move.promotion || ''}`;
  }

  applyUciMove(chess, uci) {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4]
    });
  }

  buildChess(position, fen) {
    const chess = fen ? new Chess(fen) : new Chess();
    if (fen) return chess;

    for (const move of position.split(/\s+/).filter(Boolean)) {
      this.applyUciMove(chess, move);
    }

    return chess;
  }

  getLegalMoves(position, fen, myColor) {
    const chess = this.buildChess(position, fen);
    const expectedTurn = myColor === 'white' ? 'w' : myColor === 'black' ? 'b' : chess.turn();
    if (chess.turn() !== expectedTurn) return [];
    return chess.moves({ verbose: true }).map((move) => this.moveToUci(move));
  }

  getLegalMoveDetails(position, fen, myColor) {
    const chess = this.buildChess(position, fen);
    const expectedTurn = myColor === 'white' ? 'w' : myColor === 'black' ? 'b' : chess.turn();
    if (chess.turn() !== expectedTurn) return [];

    return chess.moves({ verbose: true }).map((move) => ({
      uci: this.moveToUci(move),
      san: move.san,
      piece: move.piece,
      from: move.from,
      to: move.to,
      captured: move.captured,
      promotion: move.promotion
    }));
  }

  isLegalMove(position, fen, myColor, move) {
    if (!move || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return false;
    return this.getLegalMoves(position, fen, myColor).includes(move);
  }

  getFallbackMove(position, fen, myColor, invalidMoves) {
    const invalid = new Set(invalidMoves);
    const legalMoves = this.getLegalMoves(position, fen, myColor).filter((move) => !invalid.has(move));
    return legalMoves[0] || null;
  }

  pieceToUciName(piece) {
    if (!piece) return 'empty';
    const color = piece.color === 'w' ? 'white' : 'black';
    const typeMap = {
      p: 'pawn',
      n: 'knight',
      b: 'bishop',
      r: 'rook',
      q: 'queen',
      k: 'king'
    };
    return `${color}_${typeMap[piece.type] || piece.type}`;
  }

  boardToSquarePieceTable(chess) {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = [
      '| rank | a | b | c | d | e | f | g | h |',
      '|---|---|---|---|---|---|---|---|---|'
    ];

    for (let rank = 8; rank >= 1; rank--) {
      const cells = files.map((file) => {
        const square = `${file}${rank}`;
        const piece = chess.get(square);
        return `${square}: ${this.pieceToUciName(piece)}`;
      });
      rows.push(`| ${rank} | ${cells.join(' | ')} |`);
    }

    return rows.join('\n');
  }

  getLastOpponentMove(position, myColor) {
    const moves = String(position || '').trim().split(/\s+/).filter(Boolean);
    if (!moves.length) return 'none';

    const side = myColor === 'white' || myColor === 'black' ? myColor : null;
    if (!side) return moves[moves.length - 1];

    const myTurn = side === 'white' ? moves.length % 2 === 0 : moves.length % 2 === 1;
    if (!myTurn) return 'none';
    return moves[moves.length - 1];
  }

  formatRecentTurns(position, perSide = 5) {
    const moves = String(position || '').trim().split(/\s+/).filter(Boolean);
    if (!moves.length) return '[no moves played yet]';

    const white = [];
    const black = [];
    for (let index = 0; index < moves.length; index++) {
      const ply = index + 1;
      const color = ply % 2 === 1 ? 'white' : 'black';
      const turnNumber = Math.ceil(ply / 2);
      const entry = { ply, line: `[${color}] plays turn ${turnNumber}: ${moves[index]}` };
      if (color === 'white') white.push(entry);
      else black.push(entry);
    }

    const selected = [
      ...white.slice(-perSide),
      ...black.slice(-perSide)
    ].sort((a, b) => a.ply - b.ply);

    return selected.map((item) => item.line).join('\n');
  }

  formatLegalMoveMenu(legalMoves) {
    return legalMoves.map((move) => move.uci).join(' ');
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async watchGame(gameInfo) {
    while (true) {
      const shouldReconnect = await this.watchGameStream(gameInfo);
      if (!shouldReconnect) return;

      console.log(`[${gameInfo.id}] Stream closed while game is active; reconnecting in 5s`);
      await this.sleep(5000);
    }
  }

  async watchGameStream(gameInfo) {
    const gameId = gameInfo.id;
    
    // Build position from lastMove if available
    let position = '';
    if (gameInfo.lastMove) {
      position = gameInfo.lastMove;
    }
    
    const stateStream = await this.fetchStream(`${this.apiBase}/bot/game/stream/${gameId}`);
    
    let fen = '';
    let myColor = this.inferMyColor(gameInfo, {});
    let lastMoveAttemptForPly = -1;
    let lastFenUsedForLastMove = '';
    let gameStillActive = true;
    
    for await (const line of stateStream) {
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        const state = this.getStatePayload(event);
        const status = state.status || event.status;
        if (status && status !== 'started') gameStillActive = false;
        
        // Update FEN
        if (event.fen) fen = event.fen;
        if (state.fen) fen = state.fen;
        
        if (typeof state.moves === 'string') {
          position = state.moves.trim();
        } else if (state.lm && fen !== lastFenUsedForLastMove) {
          position = `${position} ${state.lm}`.trim();
          lastFenUsedForLastMove = fen;
        }

        myColor = myColor || this.inferMyColor(gameInfo, event);
        if (!myColor) {
          console.log(`[${gameId}] Waiting for player data to identify bot color`);
          continue;
        }
        await this.sendGameIntroChat(gameId, myColor);
        
        const moves = position.split(/\s+/).filter(Boolean);
        const whiteToMove = this.getWhiteToMove(state, fen, position);
        const isMyTurn = (myColor === 'white' && whiteToMove) || (myColor === 'black' && !whiteToMove);
        const lastMove = state.lm || moves[moves.length - 1] || 'start';

        console.log(`[${gameId}] Last move: ${lastMove}`);
        console.log(`[${gameId}] Bot color: ${myColor}, turn: ${whiteToMove ? 'white' : 'black'}, isMyTurn=${isMyTurn}, fen=${fen || 'unavailable'}`);

        if (isMyTurn && moves.length !== lastMoveAttemptForPly) {
          lastMoveAttemptForPly = moves.length;
          console.log(`[${gameId}] It's our turn! Position: ${position}`);
          const moveResult = await this.makeAIMove(gameId, position, fen, myColor);
          if (moveResult?.resync) {
            console.log(`[${gameId}] Forcing stream resync after move-state mismatch`);
            return true;
          }
        }
        
      } catch (err) {
        console.error(`[${gameId}] State parse error:`, err.message);
      }
    }
    
    console.log(`Game ${gameId} ended`);
    return gameStillActive;
  }

  async makeAIMove(gameId, position, fen, myColor) {
    console.log(`[${gameId}] AI thinking...`);
    const invalidMoves = [];
    const runtimeConfig = this.gameRuntimeConfig.get(gameId) || this.loadRuntimeConfig();
    const currentChess = this.buildChess(position, fen);
    const currentFen = currentChess.fen();
    const lastOpponentMove = this.getLastOpponentMove(position, myColor);
    const legalMoves = this.getLegalMoveDetails(position, fen, myColor);
    
    if (!legalMoves.length) {
      console.log(`[${gameId}] No legal moves available locally; skipping move`);
      return { resync: false };
    }

    const legalMoveMenu = this.formatLegalMoveMenu(legalMoves);
    let correctionFeedback = '';
    let lastRejectedMove = '';
    const retryDelayMs = 300000; // 5 minutes

    while (true) {
      let result;
      try {
        result = await this.getAIMove(
          gameId,
          position.trim(),
          currentFen,
          lastOpponentMove,
          myColor,
          invalidMoves,
          legalMoves,
          runtimeConfig,
          correctionFeedback,
          lastRejectedMove
        );
      } catch (err) {
        console.error(`[${gameId}] AI API failure: ${err.message}. Retrying in 5m...`);
        await this.sendChatMessage(gameId, 'player', `AI API error: ${err.message}. Retrying in 5m...`);
        await this.sleep(retryDelayMs);
        continue;
      }

      const move = result.move;
      const rawResponse = (result.content || "").trim() || "<empty>";
      
      if (!move || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
        console.log(`[${gameId}] Invalid move format: ${move || "<none>"} (Raw response: "${rawResponse}"). Retrying in 5m...`);
        correctionFeedback = `Your previous answer "${rawResponse}" did not provide exactly one legal UCI move. Reply with only one UCI move from the legal move list. Legal UCI moves again: ${legalMoveMenu}`;
        lastRejectedMove = move || "";
        if (move) invalidMoves.push(move);
        await this.sendChatMessage(gameId, 'player', `AI format error. Retrying in 5m...`);
        await this.sleep(retryDelayMs);
        continue;
      }

      if (!this.isLegalMove(position, fen, myColor, move)) {
        console.log(`[${gameId}] AI chose illegal move: ${move}. Retrying in 5m...`);
        correctionFeedback = `Your previous move "${move}" is illegal in this position. Choose a different move from the legal move list. Legal UCI moves again: ${legalMoveMenu}`;
        lastRejectedMove = move;
        invalidMoves.push(move);
        await this.sendChatMessage(gameId, 'player', `AI illegal move: ${move}. Retrying in 5m...`);
        await this.sleep(retryDelayMs);
        continue;
      }
      
      console.log(`[${gameId}] Attempting move: ${move}`);
      
      try {
        await this.fetch(`${this.apiBase}/bot/game/${gameId}/move/${move}`, { method: 'POST' });
        console.log(`[${gameId}] Move successful: ${move}`);
        return { resync: false };
      } catch (err) {
        if (err.message.includes('400')) {
          console.log(`[${gameId}] Lichess rejected locally-legal move ${move} with HTTP 400; requesting stream resync`);
          return { resync: true };
        }
        console.error(`[${gameId}] Lichess move submission failed: ${err.message}. Retrying in 5m...`);
        await this.sendChatMessage(gameId, 'player', `Lichess error: ${err.message}. Retrying in 5m...`);
        await this.sleep(retryDelayMs);
      }
    }
  }

  generateAsciiBoard(chess) {
    const ascii = chess.ascii();
    // chess.js ascii() looks like:
    //   +-------------------------------+
    // 8 | r  n  b  q  k  b  n  r |
    // 7 | p  p  p  p  .  p  p  p |
    // ...
    //   +-------------------------------+
    //     a  b  c  d  e  f  g  h
    
    // We want to clean it up a bit to match the user's requested format
    const lines = ascii.split('\n');
    const boardLines = lines.slice(1, 9).map(line => {
      // line is like "8 | r  n  b  q  k  b  n  r |"
      // Remove trailing "|" and extra spaces
      return line.replace(/\s*\|\s*$/, '').replace(/\s+/g, ' ');
    });
    return boardLines.join('\n') + '\n    a b c d e f g h';
  }

  generatePieceList(chess, color) {
    const pieces = {
      'King': [],
      'Queen': [],
      'Rooks': [],
      'Bishops': [],
      'Knights': [],
      'Pawns': []
    };

    const nameMap = {
      'k': 'King',
      'q': 'Queen',
      'r': 'Rooks',
      'b': 'Bishops',
      'n': 'Knights',
      'p': 'Pawns'
    };

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const square = String.fromCharCode(97 + c) + (8 - r);
        const piece = chess.get(square);
        if (piece && piece.color === color) {
          pieces[nameMap[piece.type]].push(square);
        }
      }
    }

    return Object.entries(pieces)
      .filter(([_, squares]) => squares.length > 0)
      .map(([name, squares]) => `${name}: ${squares.join(', ')}`)
      .join('\n');
  }

  logAI(gameId, model, type, content) {
    const timestamp = new Date().toISOString();
    const commonPrefix = `[${timestamp}][${gameId}][${model}]`;
    
    // 1. Big log file for input and output: [game][model][input/output]
    const inOutEntry = `${commonPrefix}[${type}]\n${content}\n${'-'.repeat(80)}\n`;
    fs.appendFileSync('stream_logs/ai_in_out.log', inOutEntry);

    if (type === 'output') {
      // 2. Big log file for output: [game][model][output]
      const outPrefixedEntry = `${commonPrefix}[output]\n${content}\n${'-'.repeat(80)}\n`;
      fs.appendFileSync('stream_logs/ai_out_prefixed.log', outPrefixedEntry);

      // 3. Big log file for output: [game][model]
      const outEntry = `${commonPrefix}\n${content}\n${'-'.repeat(80)}\n`;
      fs.appendFileSync('stream_logs/ai_out.log', outEntry);
    }
  }

  async getAIMove(gameId, position, fen, lastOpponentMove, myColor, invalidMoves = [], legalMoves = [], runtimeConfig = this.loadRuntimeConfig(), correctionFeedback = '', lastRejectedMove = '') {
    const side = myColor || 'the side to move';
    const sideName = side.charAt(0).toUpperCase() + side.slice(1);
    const chess = this.buildChess(position, fen);
    const asciiBoard = this.generateAsciiBoard(chess);
    const whitePieces = this.generatePieceList(chess, 'w');
    const blackPieces = this.generatePieceList(chess, 'b');
    
    const legalMoveMenu = this.formatLegalMoveMenu(legalMoves);
    const prompt = `FEN: ${fen}

Side to move: ${sideName}
Board:
${asciiBoard}

White pieces:
${whitePieces}

Black pieces:
${blackPieces}

Last opponent move (UCI): ${lastOpponentMove}.

Legal UCI moves:
${legalMoveMenu}

Rejected moves (must not be played): ${invalidMoves.length ? invalidMoves.join(', ') : 'none'}.
Last rejected move: ${lastRejectedMove || 'none'}.
Failure feedback from previous attempt: ${correctionFeedback || 'none'}.

Choose exactly one move copied from the Legal UCI moves line.
Return only the UCI string.`;
    const messages = [
      { role: 'system', content: `You are a chess master that is playing chess on lichess as side ${side}. You will be presented with the state of the chess board and a list of legal moves. Choose need to choose 1 move from that explicit legal move list. You may reason privately, but your final visible answer must be one UCI move and nothing else. The answer must match this pattern: file-rank-file-rank, for example e2e4.` },
      { role: 'user', content: prompt }
    ];
    
    try {
      const isOpenRouter = runtimeConfig.aiEndpoint.includes('openrouter.ai');
      const headers = { 'Content-Type': 'application/json' };
      if (runtimeConfig.apiKey) {
        headers['Authorization'] = `Bearer ${runtimeConfig.apiKey}`;
      }

      if (isOpenRouter) {
        headers['HTTP-Referer'] = 'https://github.com/franclaw/lichess-bot';
        headers['X-Title'] = 'Lichess AI Bot';
        if (runtimeConfig.sessionId) {
          headers['X-Session-ID'] = runtimeConfig.sessionId;
        }
      }

      const reasoning = { enabled: true };
      if (runtimeConfig.reasoningEffort) {
        reasoning.effort = runtimeConfig.reasoningEffort;
      } else if (runtimeConfig.reasoningTokens) {
        reasoning.max_tokens = runtimeConfig.reasoningTokens;
      }

      const MAX_DELAY = 15 * 60 * 1000; // 15 minutes
      let attempt = 0;
      while (true) {
        this.logAI(gameId, runtimeConfig.model, 'input', JSON.stringify(messages, null, 2));
        try {
          const response = await fetch(`${runtimeConfig.aiEndpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: runtimeConfig.model,
              messages,
              temperature: runtimeConfig.temperature,
              max_tokens: runtimeConfig.maxTokens,
              reasoning,
              stream: true,
              user: this.myBotUsername,
              ...(isOpenRouter && runtimeConfig.sessionId && {
                metadata: {
                  session_id: runtimeConfig.sessionId
                }
              })
            })
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter ? Number(retryAfter) * 1000 : Math.min(Math.pow(2, attempt) * 2000, MAX_DELAY);
            console.error(`[RATE LIMIT] AI request got HTTP 429; retrying in ${Math.round(delay/1000)}s...`);
            await this.sleep(delay);
            attempt++;
            continue;
          }

          if (response.status >= 500) {
            const delay = Math.min(Math.pow(2, attempt) * 2000, MAX_DELAY);
            console.error(`[${response.status}] AI service error, retrying in ${Math.round(delay/1000)}s (attempt ${attempt + 1})...`);
            await this.sleep(delay);
            attempt++;
            continue;
          }

          if (!response.ok) {
            const errorText = await response.text().catch(() => 'no body');
            console.error(`[${gameId}] AI request error status=${response.status} body=${errorText}`);
            throw new Error(`AI API error: ${response.status}`);
          }

          // Process stream
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let content = '';
          const logPath = `stream_logs/stream-${gameId}-attempt-${attempt + 1}.log`;
          const logStream = fs.createWriteStream(logPath);
          
          try {
            let buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value, { stream: true });
              logStream.write(chunk);
              buffer += chunk;
              
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (trimmed.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(trimmed.slice(6));
                    if (data.error) {
                      console.error(`[${gameId}] AI provider returned error in stream:`, JSON.stringify(data.error));
                      if (data.error.code === 524 || data.error.code === 502 || data.error.code === 429 || data.error.message?.includes('timeout')) {
                        throw { isTransient: true, message: data.error.message || data.error.code };
                      }
                      throw new Error(`AI provider error: ${data.error.message || data.error.code}`);
                    }
                    const delta = data.choices?.[0]?.delta;
                    if (delta) {
                      content += delta.content || delta.reasoning_content || delta.reasoning || '';
                    }
                  } catch (e) {
                    if (e.isTransient) throw e;
                    // Ignore parse errors for partial/malformed JSON in stream unless it was our transient error
                  }
                }
              }
            }
          } finally {
            logStream.end();
          }

          if (!content) {
            console.error(`[${gameId}] AI response empty choice content`);
            throw new Error('AI response empty');
          }

          // Log the output for this attempt
          this.logAI(gameId, runtimeConfig.model, 'output', content);

          return {
            move: this.parseMove(content, legalMoves),
            content,
            messages: [
              ...messages,
              { role: 'assistant', content }
            ]
          };
        } catch (err) {
          const delay = Math.min(Math.pow(2, attempt) * 2000, MAX_DELAY);
          if (err.isTransient) {
            console.log(`[${gameId}] Transient error during stream, retrying in ${Math.round(delay/1000)}s (attempt ${attempt + 1}): ${err.message}`);
          } else {
            console.error(`[${gameId}] AI attempt ${attempt + 1} failed: ${err.message}. Retrying in ${Math.round(delay/1000)}s...`);
          }
          await this.sleep(delay);
          attempt++;
        }
      }
      throw new Error('AI API failed after 5 attempts');
    } catch (err) {
      console.error(`[${gameId}] AI request failed:`, err.message);
      throw err;
    }
  }

  parseMove(content, legalMoves = []) {
    if (!content) return null;
    
    const legalByUci = new Map(legalMoves.map((move) => [move.uci, move]));

    const extractUci = (text) => {
      const cleaned = text.replace(/```[a-z]*\n?/gi, ' ').replace(/```/g, ' ');
      const tokens = [...cleaned.matchAll(/\b([a-h][1-8][a-h][1-8][qrbn]?)\b/g)].map((match) => match[1]);
      if (!tokens.length) return null;

      // Prefer legal tokens, and prefer the last one in case the model listed options first.
      if (legalByUci.size > 0) {
        const legalTokens = tokens.filter((token) => legalByUci.has(token));
        if (legalTokens.length) return legalTokens[legalTokens.length - 1];
      }

      return tokens[tokens.length - 1];
    };

    // Gemma-style channel output: prefer explicit final channel when present.
    const finalChannelMatch = content.match(/<\|channel\>\s*final\b([\s\S]*)/i);
    if (finalChannelMatch) {
      const move = extractUci(finalChannelMatch[1]);
      if (move) return move;
    }

    // Generic final-answer markers.
    const finalLineMatch = content.match(/(?:final answer|answer)\s*[:\-]\s*([^\n]+)/i);
    if (finalLineMatch) {
      const move = extractUci(finalLineMatch[1]);
      if (move) return move;
    }

    const fallbackMove = extractUci(content);
    if (fallbackMove) return fallbackMove;

    const normalized = content.trim().replace(/[`"'.]/g, '');
    for (const move of legalByUci.values()) {
      const san = move.san.replace(/[+#]$/, '');
      if (normalized === move.san || normalized === san || normalized.includes(move.san) || normalized.includes(san)) {
        return move.uci;
      }
    }
    
    return null;
  }

  async fetch(url, options = {}) {
    const response = await fetch(url, { ...options, headers: this.headers });
    const text = await response.text();

    if (response.status === 400) {
      console.error(`[HTTP 400] Lichess API error for ${url}; body=${text || '<empty>'}`);
      console.error(`[HTTP 400] Headers: ${JSON.stringify(this.headers)}`);
    }

    if (response.status === 429) {
      console.error(`[RATE LIMIT] Lichess API request got HTTP 429 for ${url}; retry-after=${response.headers.get('retry-after') || 'not provided'}; body=${text || '<empty>'}`);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);

    if (!text) return {};

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

console.log('Starting Lichess AI Bot...\n');
const bot = new LichessBot();
bot.init().catch(console.error);
