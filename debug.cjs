const config = require('./config.cjs');

async function debugEvents() {
  console.log('Debugging Lichess events...');
  
  const headers = { 
    Authorization: `Bearer ${config.accessToken}`,
    'Content-Type': 'application/json'
  };
  
  try {
    const response = await fetch('https://lichess.org/api/stream/event', { headers });
    
    if (!response.ok) {
      console.error(`HTTP error: ${response.status}`);
      return;
    }
    
    console.log(`Status: ${response.status} - Events stream opened\n`);
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    let count = 0;
    const maxLines = 20;
    
    while (count < maxLines) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line) continue;
        
        console.log(`[EVENT ${++count}] ${line}`);
        
        try {
          const event = JSON.parse(line);
          console.log(`  Parsed: type=${event.type}`, 
            event.game ? `game=${event.game.id}` : '',
            event.challenge ? `challenge=${event.challenge.id}` : '');
        } catch (err) {
          console.log(`  Raw line`);
        }
        
        if (count >= maxLines) break;
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

debugEvents();
