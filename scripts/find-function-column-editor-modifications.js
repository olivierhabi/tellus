const fs = require('fs');
const path = require('path');

const sessionsDir = path.join(process.env.HOME, '.codex/sessions/2026/06/21');
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

let modifications = [];

for (const file of files) {
  const filePath = path.join(sessionsDir, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Look for exec_command that might modify FunctionColumnEditor
      if (obj.payload?.type === 'function_call' && obj.payload?.name === 'exec_command') {
        try {
          const args = JSON.parse(obj.payload.arguments);
          const cmd = args.cmd || '';

          // Check for sed -i, or any file modification
          if ((cmd.includes('sed -i') || cmd.includes('sed -w') || cmd.includes('python') || cmd.includes('perl') || cmd.includes('awk')) &&
              cmd.includes('FunctionColumnEditor')) {
            modifications.push({
              file: file,
              line: i,
              timestamp: obj.timestamp,
              cmd: cmd.substring(0, 2000),
              call_id: obj.payload.call_id
            });
          }
        } catch (e) {}
      }

    } catch (e) {
      // Skip malformed JSON
    }
  }
}

console.log('Found', modifications.length, 'potential modifications');

for (const mod of modifications) {
  console.log('\n========================================');
  console.log('Session:', mod.file);
  console.log('Timestamp:', mod.timestamp);
  console.log('Call ID:', mod.call_id);
  console.log('Command:', mod.cmd);
}

fs.writeFileSync('/tmp/function-column-editor-modifications.json', JSON.stringify(modifications, null, 2));
console.log('\n\nFull results saved to /tmp/function-column-editor-modifications.json');
