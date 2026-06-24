#!/bin/bash
# scripts/test-frontend-revert.sh

FILE="../tellus-fe/components/workshop/SpecialColumnsEditor.tsx"

if [ ! -f "$FILE" ]; then
  echo "Error: $FILE does not exist!"
  exit 1
fi

# Find the definition of SortableSpecialColumnRow
# extract lines inside SortableSpecialColumnRow and check for useFunctionFields or onFunctionColumnClick
content=$(awk '/function SortableSpecialColumnRow/,/^}/' "$FILE")

echo "$content" | grep -q "useFunctionFields"
HAS_USE_FN_FIELDS=$?

echo "$content" | grep -q "onFunctionColumnClick"
HAS_ON_FN_CLICK=$?

if [ $HAS_USE_FN_FIELDS -eq 0 ]; then
  echo "Error: SortableSpecialColumnRow still contains useFunctionFields!"
  exit 1
fi

if [ $HAS_ON_FN_CLICK -eq 0 ]; then
  echo "Error: SortableSpecialColumnRow still contains onFunctionColumnClick!"
  exit 1
fi

echo "Success: Reversal verified. SortableSpecialColumnRow has neither useFunctionFields nor onFunctionColumnClick."
exit 0
