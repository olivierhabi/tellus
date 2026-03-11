# TASK 29: Create the Test Data Generator

**File to create:** `/src/tests/helpers/testDataGenerator.js`

**Purpose:** Generates realistic test CSV files with configurable row counts and intentional edge cases. Used by the test suite (Task 28) and for manual testing.

**Specification:**

Export: `generateEmployeeCSV(filePath, rowCount, options)` that creates a CSV file with:

- **Employee ID:** Sequential `"EMP-001"`, `"EMP-002"`, etc. (zero-padded to 3+ digits).

- **Names:** Use the following lists (randomly combined):
  - First names (20): `["Melissa", "Jean-Pierre", "Alice", "Omar", "Fatima", "David", "Grace", "Emmanuel", "Sophie", "Patrick", "Diane", "Samuel", "Claudine", "Eric", "Marie", "Joseph", "Yvonne", "Robert", "Amina", "James"]`
  - Last names (20): `["Chang", "Habimana", "Uwimana", "Nkurunziza", "Mugisha", "Ishimwe", "Kayitesi", "Ndayisaba", "Mukamana", "Bizimungu", "Ingabire", "Nsengimana", "Uwase", "Kamanzi", "Mutoni", "Rugamba", "Gasana", "Uwineza", "Tuyishime", "Dushime"]`

- **Emails:** `firstname.lastname@company.com` (lowercased).

- **Salaries:** Normal distribution with mean 120,000 and standard deviation 40,000. Values outside the range [40,000, 250,000] are resampled (not clamped).

- **Start dates:** Random dates between 2015-01-01 and 2025-03-11 in `YYYY-MM-DD` format.

- **Departments:** `["Engineering", "Finance", "Marketing", "Operations", "HR"]` with weighted distribution: 40% Engineering, 20% Finance, 15% Marketing, 15% Operations, 10% HR.

- **isActive:** 90% `"true"`, 10% `"false"`.

- **Skills:** Random selection of 1-5 from this list of 20:
  `["python", "java", "sql", "javascript", "typescript", "react", "node", "docker", "kubernetes", "aws", "gcp", "azure", "machine-learning", "data-analysis", "project-management", "agile", "communication", "leadership", "excel", "tableau"]`
  Formatted as comma-separated string in a single CSV field (e.g., `"python,java,sql"`).

- **Locations:** Random geopoints within Rwanda (lat: -1.0 to -3.0, lon: 28.5 to 30.9), formatted as `"lat,lon"` string.

- **Age:** Normal distribution with mean 35 and standard deviation 10. Values outside [22, 65] are resampled (not clamped).

**Options for injecting edge cases:**
- `duplicateKeyCount` (number, default: 0): Number of duplicate PKs to inject. Duplicate rows copy the PK of the first generated row and are appended at the end of the CSV.
- `nullRequiredCount` (number, default: 0): Number of rows where `fullName` is set to empty string. Appended at the end.
- `badTypeCount` (number, default: 0): Number of rows where `salary` is set to the literal string `"INVALID"`. Appended at the end.
- `emptyRowCount` (number, default: 0): Number of completely empty rows. Appended at the end.
- `seed` (string, default: none): If provided, use this seed for the pseudo-random number generator to produce deterministic output across runs.

**Edge case rows are always appended after all valid rows**, not interspersed. This makes it easy to generate a "clean" CSV by setting all edge case counts to 0.

**Additional exports (stubs for Day 4):**
- `generateCompanyCSV(filePath, rowCount)` — Stub that throws `Error('Not implemented — see Day 4 task specifications')`.
- `generateTicketCSV(filePath, rowCount, employeeIds)` — Stub that throws `Error('Not implemented — see Day 4 task specifications')`.

These will be fully specified and implemented on Day 4 when link type testing is needed.

**Test to verify:** Generate a CSV with 100 rows and `seed: "test"`, verify it has 100 data rows plus a header. Generate again with the same seed, verify the output is identical. Generate with `duplicateKeyCount: 2, nullRequiredCount: 1`, verify the last 3 rows contain the expected edge cases.
