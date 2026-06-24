import WebSocket from 'ws';

const targetUrl = 'ws://localhost:3000/ws';

console.log('Connecting to /ws on port 3000...');
const ws = new WebSocket(targetUrl);

ws.on('open', () => {
  console.log('✅ Connected to /ws successfully!');
  // Wait a few seconds to see if it closes
  setTimeout(() => {
    console.log('Still connected after 3 seconds!');
    ws.close();
  }, 3000);
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`Connection closed: code=${code}, reason=${reason.toString()}`);
});
