const config = require('./config.cjs');

async function testAI(position, testName) {
  const prompt = `Chess position: ${position}. Return only the next move in UCI format (e.g., "e2e4"). No explanation.`;
  
  try {
    console.log(`Test: ${testName}`);
    console.log(`Position: ${position}`);
    
    const response = await fetch(`${config.aiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 10
      })
    });

    if (!response.ok) {
      console.error(`AI API error: ${response.status}`);
      return;
    }
    
    const data = await response.json();
    const moveContent = data.choices?.[0]?.message?.content || '';
    
    console.log(`Raw response: "${moveContent}"`);
    
    // Parse the move
    let move = null;
    if (moveContent) {
      const moves = moveContent.match(/[a-h][1-8][a-h][1-8]/);
      if (moves && moves[0]) {
        move = moves[0];
      }
    }
    
    if (move && /^\w{4}$/.test(move)) {
      console.log(`✅ Move: ${move}`);
    } else {
      console.log(`❌ Failed to parse valid UCI move`);
    }
    console.log('');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

// Test positions
(async () => {
  console.log('Testing AI with various chess positions...\n');
  await testAI('e2e4 c7c5', 'Open Sicilian');
  await testAI('e2e4 e7e5 g1f3 b8c6 f1b5', 'Ruy Lopez');  
  await testAI('d2d4 d7d5 c1f4', 'Queen\'s Gambit Accepted');
  console.log('All tests completed!');
})();
