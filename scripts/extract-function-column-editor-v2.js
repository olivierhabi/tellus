const fs = require('fs');
const path = require('path');

const sessionFile = path.join(process.env.HOME, '.codex/sessions/2026/06/21/rollout-2026-06-21T02-01-29-019ee77b-7844-7143-8b37-f18633152e9d.jsonl');
const content = fs.readFileSync(sessionFile, 'utf-8');
const lines = content.split('\n');

let fullOutput = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;

  try {
    const obj = JSON.parse(line);

    // Look for the cat command output
    if (obj.payload?.type === 'function_call_output' &&
        obj.payload?.call_id === 'tool_exec_command_PkStbJwYpovoQgEWPx5c') {
      fullOutput = obj.payload.output || '';
      console.log('Found output, length:', fullOutput.length);
      break;
    }

  } catch (e) {
    // Skip malformed JSON
  }
}

if (fullOutput) {
  // Parse the output format
  // Format: Chunk ID: ...\nWall time: ...\nProcess exited with code 0\nOriginal token count: ...\nOutput:\nTotal output lines: XXX\n<actual content>

  const outputIdx = fullOutput.indexOf('Output:\n');
  if (outputIdx !== -1) {
    let actualContent = fullOutput.substring(outputIdx + 'Output:\n'.length);

    // Remove the "Total output lines: XXX" prefix
    actualContent = actualContent.replace(/^Total output lines: \d+\n/, '');

    const outputPath = '/Users/olivierhabimana/Desktop/projects/tellus/scripts/function-column-editor-extracted.tsx';
    fs.writeFileSync(outputPath, actualContent);
    console.log('Saved to:', outputPath);
    console.log('Content length:', actualContent.length);
    console.log('Lines:', actualContent.split('\n').length);
    console.log('\nFirst 200 chars:');
    console.log(actualContent.substring(0, 200));
    console.log('\nLast 200 chars:');
    console.log(actualContent.substring(actualContent.length - 200));
  }
} else {
  console.log('Could not find output');
}
