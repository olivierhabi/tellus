const fs = require('fs');
const path = require('path');

const sessionsDir = path.join(process.env.HOME, '.codex/sessions/2026/06/21');
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

let found = [];

for (const file of files) {
  const filePath = path.join(sessionsDir, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Look for exec_command with file operations
      if (obj.payload?.type === 'function_call' && obj.payload?.name === 'exec_command') {
        try {
          const args = JSON.parse(obj.payload.arguments);
          const cmd = args.cmd || '';

          // Look for sed write operations or cat with heredocs
          if (cmd.includes('FunctionColumnEditor')) {
            found.push({
              file: file,
              line: i,
              timestamp: obj.timestamp,
              type: 'exec_command',
              cmd: cmd.substring(0, 1000),
              call_id: obj.payload.call_id
            });
          }

          // Look for echo with file content
          if (cmd.includes('cat >') || cmd.includes('cat <<') || cmd.includes('tee ') || cmd.includes('sed -i') || cmd.includes('echo >') || cmd.includes('printf >')) {
            if (cmd.includes('FunctionColumnEditor') || cmd.includes('function-column') || cmd.includes('functionColumn') || cmd.includes('conditionalFormatting')) {
              found.push({
                file: file,
                line: i,
                timestamp: obj.timestamp,
                type: 'file_write_cmd',
                cmd: cmd.substring(0, 5000)
              });
            }
          }
        } catch (e) {}
      }

      // Also check function_call_output for file content in output
      if (obj.payload?.type === 'function_call_output') {
        const output = obj.payload.output || '';
        if (output.includes('FunctionColumnEditor.tsx') && output.includes('export')) {
          found.push({
            file: file,
            line: i,
            timestamp: obj.timestamp,
            type: 'output_with_function_column',
            output_snippet: output.substring(0, 2000)
          });
        }
      }

    } catch (e) {
      // Skip malformed JSON
    }
  }
}

console.log('Found', found.length, 'potential matches');

// Group by type
const byType = {};
for (const match of found) {
  const t = match.type;
  if (!byType[t]) byType[t] = [];
  byType[t].push(match);
}

for (const [type, matches] of Object.entries(byType)) {
  console.log('\n=== Type:', type, '(', matches.length, 'matches ) ===');
  for (const m of matches.slice(0, 10)) {
    console.log('\nSession:', m.file);
    console.log('Timestamp:', m.timestamp);
    if (m.cmd) console.log('Command:', m.cmd);
    if (m.output_snippet) console.log('Output:', m.output_snippet);
  }
}

// Save for inspection
fs.writeFileSync('/tmp/function-column-editor-cmds.json', JSON.stringify(found, null, 2));
console.log('\n\nFull results saved to /tmp/function-column-editor-cmds.json');
