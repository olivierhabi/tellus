const fs = require('fs');
const path = require('path');

const sessionFile = path.join(process.env.HOME, '.codex/sessions/2026/06/21/rollout-2026-06-21T02-01-29-019ee77b-7844-7143-8b37-f18633152e9d.jsonl');
const content = fs.readFileSync(sessionFile, 'utf-8');
const lines = content.split('\n');

let functionColumnEditorContent = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;

  try {
    const obj = JSON.parse(line);

    // Look for the cat command output
    if (obj.payload?.type === 'function_call_output' &&
        obj.payload?.call_id === 'tool_exec_command_PkStbJwYpovoQgEWPx5c') {
      const output = obj.payload.output || '';

      // Extract the actual file content from the output
      const outputMatch = output.match(/Output:\n([\s\S]*)$/);
      if (outputMatch) {
        functionColumnEditorContent = outputMatch[1];
        console.log('Found FunctionColumnEditor.tsx content, length:', functionColumnEditorContent.length);
        break;
      }
    }

  } catch (e) {
    // Skip malformed JSON
  }
}

if (functionColumnEditorContent) {
  // Remove the "Total output lines: XXX" line at the beginning and end
  functionColumnEditorContent = functionColumnEditorContent.replace(/^Total output lines: \d+\n/, '');
  functionColumnEditorContent = functionColumnEditorContent.replace(/\nTotal output lines: \d+$/, '');

  const outputPath = '/Users/olivierhabimana/Desktop/projects/tellus/scripts/function-column-editor-extracted.tsx';
  fs.writeFileSync(outputPath, functionColumnEditorContent);
  console.log('Saved to:', outputPath);
  console.log('First 500 chars:', functionColumnEditorContent.substring(0, 500));
} else {
  console.log('Could not find FunctionColumnEditor.tsx content');
}
