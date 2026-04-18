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
        if (!line.trim()) continue;
        
        console.log('Raw:', line.substring(0, 200));
        
        try {
          const state = JSON.parse(line);
          console.log('Parsed state keys:', Object.keys(state).join(', '));
          
          // Check players
          if (state.players) {
            console.log('White user:', state.players.white?.user);
            console.log('Black user:', state.players.black?.user);
          }
          if (state.gameId) console.log('Game ID:', state.gameId);
          if (state.status) console.log('Status:', state.status);
          
        } catch (err) {
          console.log('Parse error:', err.message, 'Line:', line.substring(0, 100));
        }
        
        console.log('');
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

watchGame('luPI1SBu');
