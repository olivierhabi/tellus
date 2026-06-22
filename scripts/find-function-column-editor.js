const fs = require('fs');
const path = require('path');

const sessionsDir = path.join(process.env.HOME, '.codex/sessions/2026/06/21');
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

let found = [];

for (const file of files) {
  const filePath = path.join(sessionsDir, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Check for file_edit with FunctionColumnEditor
      if (obj.payload?.type === 'file_edit' && obj.payload?.path?.includes('FunctionColumnEditor')) {
        found.push({
          file: file,
          timestamp: obj.timestamp,
          type: 'file_edit',
          path: obj.payload.path,
          content: obj.payload.content || obj.payload.new_text
        });
      }

      // Check for write_to_file with FunctionColumnEditor
      if (obj.payload?.type === 'write_to_file' && obj.payload?.path?.includes('FunctionColumnEditor')) {
        found.push({
          file: file,
          timestamp: obj.timestamp,
          type: 'write_to_file',
          path: obj.payload.path,
          content: obj.payload.content
        });
      }

      // Check in function_call parameters
      if (obj.payload?.type === 'function_call') {
        const params = obj.payload?.params || obj.payload?.arguments;
        if (params && typeof params === 'string') {
          try {
            const parsed = JSON.parse(params);
            if (parsed.file_path?.includes('FunctionColumnEditor') || parsed.path?.includes('FunctionColumnEditor')) {
              found.push({
                file: file,
                timestamp: obj.timestamp,
                type: 'function_call',
                path: parsed.file_path || parsed.path,
                content: parsed.content || parsed.new_text
              });
            }
          } catch (e) {}
        }
      }

      // Check in function_call_output for any content
      if (obj.payload?.type === 'function_call_output' && obj.payload?.output?.includes('FunctionColumnEditor')) {
        const output = obj.payload.output;
        // Look for content patterns
        if (output.includes('FunctionColumnEditor.tsx') && (output.includes('import') || output.includes('export') || output.includes('function') || output.includes('const'))) {
          found.push({
            file: file,
            timestamp: obj.timestamp,
            type: 'function_call_output',
            snippet: output.substring(0, 1000)
          });
        }
      }

    } catch (e) {
      // Skip malformed JSON
    }
  }
}

console.log('Found', found.length, 'matches');
for (const match of found) {
  console.log('\n=== MATCH ===');
  console.log('File:', match.file);
  console.log('Timestamp:', match.timestamp);
  console.log('Type:', match.type);
  console.log('Path:', match.path);
  if (match.content) {
    console.log('Content length:', match.content.length);
    console.log('Content preview:', match.content.substring(0, 500));
  }
  if (match.snippet) {
    console.log('Snippet:', match.snippet);
  }
}
