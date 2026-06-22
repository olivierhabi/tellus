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

      // Look for function_call with file editing
      if (obj.payload?.type === 'function_call') {
        // Check various parameter structures
        let params = null;
        try {
          if (typeof obj.payload.params === 'string') {
            params = JSON.parse(obj.payload.params);
          } else if (typeof obj.payload.arguments === 'string') {
            params = JSON.parse(obj.payload.arguments);
          } else {
            params = obj.payload.params || obj.payload.arguments;
          }
        } catch (e) {}

        if (params) {
          const filePathParam = params.file_path || params.path;
          const fileContent = params.content || params.new_text || params.new_source;

          if (filePathParam?.includes('FunctionColumnEditor')) {
            found.push({
              file: file,
              line: i,
              timestamp: obj.timestamp,
              type: 'function_call',
              tool: obj.payload.name || obj.payload.tool,
              path: filePathParam,
              content: fileContent,
              fullParams: params
            });
          }
        }
      }

      // Check for response items with file edits
      if (obj.payload?.type === 'response_item') {
        const innerPayload = obj.payload?.payload || {};
        if (innerPayload.type === 'file_edit' || innerPayload.type === 'write_to_file') {
          if (innerPayload.path?.includes('FunctionColumnEditor') || innerPayload.file_path?.includes('FunctionColumnEditor')) {
            found.push({
              file: file,
              line: i,
              timestamp: obj.timestamp,
              type: innerPayload.type,
              path: innerPayload.path || innerPayload.file_path,
              content: innerPayload.content || innerPayload.new_text,
              fullPayload: innerPayload
            });
          }
        }
      }

    } catch (e) {
      // Skip malformed JSON
    }
  }
}

console.log('Found', found.length, 'matches with actual file content');

for (const match of found) {
  console.log('\n========================================');
  console.log('Session:', match.file);
  console.log('Line:', match.line);
  console.log('Timestamp:', match.timestamp);
  console.log('Type:', match.type);
  console.log('Path:', match.path);
  if (match.content) {
    console.log('Content length:', match.content.length);
    console.log('Content:\n', match.content);
  }
}

// Also save to file for inspection
fs.writeFileSync('/tmp/function-column-editor-matches.json', JSON.stringify(found, null, 2));
console.log('\nFull results saved to /tmp/function-column-editor-matches.json');
