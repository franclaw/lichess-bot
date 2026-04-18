const config = require('./config.cjs');

async function watchGame(gameId) {
  console.log(`Watching game: ${gameId}`);
  
  const headers = { 
    Authorization: `Bearer ${config.accessToken}`,
    'Content-Type': 'application/json'
  };
  
  try {
    const response = await fetch(`https://lichess.org/api/stream/game/${gameId}`, { headers });
    
    if (!response.ok) {
      console.error(`HTTP error: ${response.status}`);
      return;
    }
    
    console.log('Game stream opened\n');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line) continue;
        
        try {
          const state = JSON.parse(line);
          
          // Check if it's our bot
          const whiteName = state.players?.white?.user?.name || '';
          const blackName = state.players?.black?.user?.name || '';
          
          console.log(`Move: ${state.moves.split(' ').pop() || 'start'}`);
          console.log(`  White: ${whiteName}, Black: ${blackName}`);
          
          // Check if it's our turn
          const isMyTurn = (whiteName.toLowerCase() === config.username.toLowerCase()) === state.whiteToMove;
          console.log(`  Is my turn: ${isMyTurn}`);
          
        } catch (err) {
          console.log('Parse error:', err.message);
        }
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

// Start with the game we know exists
watchGame('luPI1SBu');
