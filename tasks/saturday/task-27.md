## TASK 27: Build the Test Data Generator Utility

### Context
All integration tests need realistic test data. Instead of hand-crafting CSV files, this task builds a reusable test data generator that can produce datasets of any size with configurable column types and value distributions. This is particularly important for performance testing — we need to be able to generate 10K, 100K, or 1M row datasets quickly.

### Exact Specification

Create `/tests/utils/testDataGenerator.js` that exports:

**Function: `generateCsv(config)`**

Config shape:
```javascript
{
  outputPath: '/tests/fixtures/employees_10000.csv',
  rowCount: 10000,
  columns: [
    { name: 'emp_id', type: 'sequence', prefix: 'EMP-', padWidth: 6 },
    { name: 'full_name', type: 'fullName' },
    { name: 'email', type: 'email', domain: 'rra.gov.rw' },
    { name: 'department', type: 'enum', values: ['Audit', 'Compliance', 'Collections', 'Customs', 'IT', 'Legal', 'HR', 'Finance'] },
    { name: 'annual_salary', type: 'integer', min: 500000, max: 15000000 },  // RWF
    { name: 'start_date', type: 'date', min: '2010-01-01', max: '2025-03-01' },
    { name: 'is_active', type: 'boolean', trueWeight: 0.85 },
    { name: 'skills', type: 'enumArray', values: ['tax-law', 'accounting', 'forensics', 'data-analysis', 'management', 'customs', 'vat', 'excise'], minItems: 1, maxItems: 4, delimiter: '|' },
    { name: 'office_location', type: 'geopoint', bounds: { minLat: -2.8, maxLat: -1.0, minLon: 28.8, maxLon: 30.9 } },  // Rwanda bounding box
    { name: 'tin', type: 'sequence', prefix: '', padWidth: 10 },  // Taxpayer ID number
    { name: 'company_id', type: 'foreignKey', prefix: 'COMP-', range: 50 }
  ],
  primaryKeyColumn: 'emp_id',  // Which column is the PK (exempt from nullRate, used by duplicatePkRate)
  nullRate: 0.02,  // 2% of non-PK fields will be randomly set to null (empty string in CSV)
  duplicatePkRate: 0  // 0% duplicate PKs. If > 0, that fraction of rows will repeat a previously-used PK value. Only applies to the column named by primaryKeyColumn.
}
```

Supported column types:
- `sequence`: Prefix + zero-padded number. Guaranteed unique.
- `fullName`: Random first name + last name from built-in arrays (include Rwandan names: Uwimana, Habimana, Mukamana, Nsabimana, Ingabire, Niyonzima, etc.)
- `email`: firstname.lastname@domain
- `enum`: Random value from the provided array
- `enumArray`: Random subset of values, joined by delimiter
- `integer`: Random integer between min and max
- `float`: Random float between min and max, with `decimalPlaces` decimal digits (default: 2). Example config: `{ name: 'rate', type: 'float', min: 0.0, max: 100.0, decimalPlaces: 4 }`
- `date`: Random date between min and max in YYYY-MM-DD format
- `timestamp`: Random timestamp between min and max in ISO 8601 format
- `boolean`: true/false with configurable weight (trueWeight: probability of true)
- `geopoint`: Random lat,lon within the specified bounds
- `foreignKey`: Random reference to another entity (prefix + random number 1 to range)
- `uuid`: Random UUID v4
- `static`: Always the same value. Config: `{ name: 'country', type: 'static', value: 'RW' }`

The function must write the CSV file using a streaming writer (not building the entire string in memory) to support generating millions of rows.

Also export two additional format functions that accept the same config shape as `generateCsv`:

**Function: `generateJson(config)`** — Writes a JSON file containing a single top-level array of objects (one object per row). Each object's keys are the column `name` values, and values are the generated data (strings for all types except: `integer`/`float` → number, `boolean` → boolean). Must use streaming writes (open file, write `[`, write each JSON object followed by `,\n`, write `]`).

**Function: `generateJsonLines(config)`** — Writes a JSON Lines file (`.jsonl`): one JSON object per line, no enclosing array, no trailing commas. Same key/value types as `generateJson`.

**Convenience functions:**

```javascript
generateRraEmployees(count, outputPath)    // Pre-configured for RRA employee data
generateRraTaxpayers(count, outputPath)     // Pre-configured for taxpayer data
generateRraBusinesses(count, outputPath)    // Pre-configured for business data
generateRraCustomsDeclarations(count, outputPath)
generateRraProperties(count, outputPath)    // Real estate properties
```

Each convenience function calls `generateCsv` with a hardcoded config. The exact column schemas:

**`generateRraEmployees`** — uses the example config shown above (emp_id, full_name, email, department, annual_salary, start_date, is_active, skills, office_location, tin, company_id). Primary key: `emp_id`.

**`generateRraTaxpayers`** — columns:
- `tin` (sequence, prefix: '', padWidth: 10) — PK
- `full_name` (fullName)
- `district` (enum, values: ['Gasabo', 'Kicukiro', 'Nyarugenge', 'Huye', 'Musanze', 'Rubavu', 'Rusizi', 'Muhanga', 'Karongi', 'Ngoma'])
- `tax_category` (enum, values: ['PAYE', 'VAT', 'CIT', 'PIT', 'WHT'])
- `annual_income` (integer, min: 100000, max: 50000000)
- `registration_date` (date, min: '2005-01-01', max: '2025-03-01')
- `is_compliant` (boolean, trueWeight: 0.92)
- `phone` (sequence, prefix: '+2507', padWidth: 8)

**`generateRraBusinesses`** — columns:
- `business_id` (sequence, prefix: 'BIZ-', padWidth: 6) — PK
- `business_name` (fullName — used as a placeholder, generates a name string)
- `sector` (enum, values: ['Agriculture', 'Manufacturing', 'Services', 'Mining', 'Construction', 'Trade', 'Transport', 'ICT'])
- `province` (enum, values: ['Kigali', 'Eastern', 'Western', 'Northern', 'Southern'])
- `annual_turnover` (integer, min: 1000000, max: 500000000)
- `employee_count` (integer, min: 1, max: 5000)
- `registration_date` (date, min: '2000-01-01', max: '2025-03-01')
- `is_active` (boolean, trueWeight: 0.80)
- `tin` (sequence, prefix: '', padWidth: 10)

**`generateRraCustomsDeclarations`** — columns:
- `declaration_id` (sequence, prefix: 'CD-', padWidth: 8) — PK
- `importer_tin` (foreignKey, prefix: '', range: 10000)
- `declaration_date` (date, min: '2024-01-01', max: '2025-03-01')
- `port_of_entry` (enum, values: ['Kigali', 'Rusumo', 'Gatuna', 'Cyanika', 'Nemba', 'Kagitumba'])
- `hs_code` (sequence, prefix: '', padWidth: 8)
- `goods_description` (enum, values: ['Electronics', 'Textiles', 'Machinery', 'Chemicals', 'Food Products', 'Vehicles', 'Construction Materials'])
- `cif_value` (integer, min: 10000, max: 100000000)
- `duty_amount` (integer, min: 1000, max: 25000000)
- `currency` (static, value: 'RWF')
- `status` (enum, values: ['CLEARED', 'PENDING', 'HELD', 'REJECTED'])

**`generateRraProperties`** — columns:
- `property_id` (sequence, prefix: 'PROP-', padWidth: 6) — PK
- `owner_tin` (foreignKey, prefix: '', range: 10000)
- `district` (enum, values: ['Gasabo', 'Kicukiro', 'Nyarugenge', 'Huye', 'Musanze', 'Rubavu'])
- `sector` (enum, values: ['Kimironko', 'Remera', 'Gisozi', 'Kacyiru', 'Kimihurura', 'Nyamirambo'])
- `property_type` (enum, values: ['Residential', 'Commercial', 'Agricultural', 'Industrial', 'Mixed-Use'])
- `area_sqm` (float, min: 50.0, max: 10000.0, decimalPlaces: 1)
- `assessed_value` (integer, min: 5000000, max: 500000000)
- `location` (geopoint, bounds: { minLat: -2.8, maxLat: -1.0, minLon: 28.8, maxLon: 30.9 })
- `registration_date` (date, min: '2010-01-01', max: '2025-03-01')

### Validation Criteria
- Generate 1000-row CSV in under 1 second
- Generate 100K-row CSV in under 10 seconds
- Generate 1M-row CSV in under 60 seconds (streaming, not memory-bound)
- Generated CSVs are valid (parseable by csv-parse)
- Generated JSON files are valid (parseable by JSON.parse)
- Generated JSONL files have one valid JSON object per line
- Sequence columns produce unique values
- Foreign key references are within the specified range
- Null values appear at approximately the specified rate (within ±1% of target)
- The `primaryKeyColumn` is never null regardless of `nullRate`
- When `duplicatePkRate > 0`, approximately that fraction of rows have a duplicate PK
- Geopoints are within Rwanda's bounding box
- Float values have the correct number of decimal places
- All 5 convenience functions produce valid CSV files with the correct column headers
- Each convenience function's output is parseable and has the expected column count
