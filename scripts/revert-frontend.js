const fs = require('fs');
const path = require('path');

const targetPath = path.resolve(__dirname, '../../tellus-fe/components/workshop/SpecialColumnsEditor.tsx');

if (!fs.existsSync(targetPath)) {
  console.error(`File does not exist: ${targetPath}`);
  process.exit(1);
}

let content = fs.readFileSync(targetPath, 'utf8');
let modified = false;

// 1. Remove onFunctionColumnClick from SpecialColumnsEditorProps interface definition (if exists)
const propsInterfaceRegex = /readonly\s+onFunctionColumnClick\??\s*:\s*\(column\s*:\s*FunctionBackedColumnSpec\)\s*=>\s*void;/g;
if (propsInterfaceRegex.test(content)) {
  content = content.replace(propsInterfaceRegex, '');
  modified = true;
}

// 2. Remove onFunctionColumnClick from SpecialColumnsEditor parameter destructuring (if exists)
if (content.includes('onFunctionColumnClick,')) {
  content = content.replace('onFunctionColumnClick,', '');
  modified = true;
}

// 3. Remove onFunctionColumnClick pass to SortableSpecialColumnRow inside SpecialColumnsEditor (if exists)
if (content.includes('onFunctionColumnClick={onFunctionColumnClick}')) {
  content = content.replace('onFunctionColumnClick={onFunctionColumnClick}', '');
  modified = true;
}

// 4. Remove useFunctionFields definition and hook call inside SortableSpecialColumnRow (if exists)
const useFnFieldsRegex = /const\s+fields\s*=\s*useFunctionFields\([\s\S]*?col\.kind\s*===\s*"functionBacked"[\s\S]*?\);\n/g;
if (useFnFieldsRegex.test(content)) {
  content = content.replace(useFnFieldsRegex, '');
  modified = true;
}

// 5. Revert collapsed header button back to span
// (Already a span in current state, but we can do a defensive find and replace if button version is found)
if (content.includes('data-testid={`${testIdPrefix}-function-column-trigger-${col.id}`}')) {
  // If we find our button in SortableSpecialColumnRow, parse it and replace back to span
  // Safe replacement structure
  const originalSpan = `        <span className="flex-1 min-w-0 flex flex-col" title={headerLabel}>
          <span className="text-[13px] font-medium text-[#182026] truncate">
            {headerLabel}
          </span>
          {apiSubtitle ? (
            <span
              className="text-[10px] text-[#5C7080] truncate"
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {apiSubtitle}
            </span>
          ) : null}
        </span>`;

  // Locate the button match and replace it
  const buttonBlockRegex = /<button\s+type="button"\s+onClick=\{[\s\S]*?-function-column-trigger-\$\{col\.id\}[\s\S]*?<\/button>/;
  if (buttonBlockRegex.test(content)) {
    content = content.replace(buttonBlockRegex, originalSpan);
    modified = true;
  }
}

// 6. Revert Expanded Body fields.map check back to single FunctionBackedFields component
const expandedBodyRegex = /fields\.length\s*>\s*0\s*\?\s*\([\s\S]*?:\s*\(\s*<FunctionBackedFields[\s\S]*?\/>\s*\)/g;
if (expandedBodyRegex.test(content)) {
  const originalExpandedBlock = `<FunctionBackedFields
              spec={col}
              objectType={objectType}
              onChange={onChange}
              onAddFields={onAddFields}
              testIdPrefix={testIdPrefix}
            />`;
  content = content.replace(expandedBodyRegex, originalExpandedBlock);
  modified = true;
}

// Ensure isConfiguredFn is defined if buttons were removed and it was altered or removed
// (Already correct in current file)

if (modified) {
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log(`Successfully reverted frontend changes in SpecialColumnsEditor.tsx.`);
} else {
  console.log('No frontend modifications detected. SpecialColumnsEditor.tsx is already clean/pristine on disk.');
}
