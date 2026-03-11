// ---------------------------------------------------------------------------
// Indexing Error Collector
//
// Collects, deduplicates, and summarizes all errors that occur during an
// indexing pipeline run. Instead of failing on the first error, the system
// collects all errors and presents them together so the user can fix all
// issues at once.
//
// In Palantir's Object Data Funnel, pipeline errors are accumulated and
// reported in the Funnel status. Operators can see which rows failed, why
// they failed, and fix all issues before retrying.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid error/warning categories. */
export type ErrorCategory =
  | "primary_key"
  | "type_conversion"
  | "required_null"
  | "opensearch_rejection"
  | "file_read";

/** Details for a single error or warning entry. */
export interface ErrorDetails {
  /** Row number in the CSV file (optional). */
  row?: number;
  /** Property name involved (optional). */
  property?: string;
  /** The offending value (optional). */
  value?: string;
  /** Human-readable description (required). */
  message: string;
}

/** A stored entry — details plus category and level. */
export interface CollectedEntry {
  category: ErrorCategory;
  row?: number;
  property?: string;
  value?: string;
  message: string;
}

/** Summary for a single (category, property) group. */
export interface CategorySummary {
  count: number;
  sample: string;
}

/** The grouped summary returned by getSummary(). */
export interface Summary {
  errorCount: number;
  warningCount: number;
  errorsByCategory: Record<string, CategorySummary>;
  warningsByCategory: Record<string, CategorySummary>;
}

/** The full report returned by getFullReport(). */
export interface FullReport {
  errors: CollectedEntry[];
  warnings: CollectedEntry[];
  summary: Summary;
}

// ---------------------------------------------------------------------------
// Valid categories
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "primary_key",
  "type_conversion",
  "required_null",
  "opensearch_rejection",
  "file_read",
]);

// ---------------------------------------------------------------------------
// Human-readable category descriptions for summary messages
// ---------------------------------------------------------------------------

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  primary_key: "primary key",
  type_conversion: "type conversion",
  required_null: "null values for required property",
  opensearch_rejection: "OpenSearch rejection",
  file_read: "file read",
};

// ---------------------------------------------------------------------------
// IndexingErrorCollector
// ---------------------------------------------------------------------------

/**
 * Collects, deduplicates, and summarizes errors and warnings that occur
 * during an indexing pipeline run.
 *
 * Usage:
 * ```ts
 * const collector = new IndexingErrorCollector();
 * collector.addError("type_conversion", { row: 42, property: "salary", message: "..." });
 * collector.addWarning("primary_key", { row: 1, message: "whitespace" });
 *
 * if (collector.hasErrors()) {
 *   const report = collector.getFullReport();
 *   // present to user
 * }
 * ```
 */
export class IndexingErrorCollector {
  private readonly errors: CollectedEntry[] = [];
  private readonly warnings: CollectedEntry[] = [];

  // -----------------------------------------------------------------------
  // addError()
  // -----------------------------------------------------------------------

  /**
   * Add an error to the collection. Errors are fatal issues that indicate
   * data that could not be indexed.
   *
   * @param category - One of the valid error categories.
   * @param details  - Error details including a required `message` field.
   * @throws If category is not valid.
   */
  addError(category: ErrorCategory, details: ErrorDetails): void {
    this.validateCategory(category);
    this.errors.push(this.toEntry(category, details));
  }

  // -----------------------------------------------------------------------
  // addWarning()
  // -----------------------------------------------------------------------

  /**
   * Add a warning to the collection. Warnings are non-fatal issues (e.g.
   * whitespace in primary keys, truncated values).
   *
   * @param category - One of the valid error categories.
   * @param details  - Warning details including a required `message` field.
   * @throws If category is not valid.
   */
  addWarning(category: ErrorCategory, details: ErrorDetails): void {
    this.validateCategory(category);
    this.warnings.push(this.toEntry(category, details));
  }

  // -----------------------------------------------------------------------
  // hasErrors()
  // -----------------------------------------------------------------------

  /**
   * Returns `true` if any errors have been added, `false` otherwise.
   * Warnings do NOT count.
   */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  // -----------------------------------------------------------------------
  // getSummary()
  // -----------------------------------------------------------------------

  /**
   * Returns a grouped/deduplicated summary. Errors and warnings are grouped
   * by the `(category, property)` tuple. Entries with the same category and
   * property are counted together and represented by a single summary line.
   */
  getSummary(): Summary {
    return {
      errorCount: this.errors.length,
      warningCount: this.warnings.length,
      errorsByCategory: this.groupEntries(this.errors),
      warningsByCategory: this.groupEntries(this.warnings),
    };
  }

  // -----------------------------------------------------------------------
  // getFullReport()
  // -----------------------------------------------------------------------

  /**
   * Returns all individual errors and warnings with full details, plus the
   * grouped summary.
   */
  getFullReport(): FullReport {
    return {
      errors: [...this.errors],
      warnings: [...this.warnings],
      summary: this.getSummary(),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private validateCategory(category: string): void {
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(
        `Invalid error category: '${category}'. Must be one of: ${[...VALID_CATEGORIES].join(", ")}`
      );
    }
  }

  private toEntry(category: ErrorCategory, details: ErrorDetails): CollectedEntry {
    const entry: CollectedEntry = {
      category,
      message: details.message,
    };
    if (details.row !== undefined) entry.row = details.row;
    if (details.property !== undefined) entry.property = details.property;
    if (details.value !== undefined) entry.value = details.value;
    return entry;
  }

  /**
   * Group entries by (category, property) tuple and produce summary lines.
   *
   * Deduplication rule: entries with the same category and same property
   * are counted together. If property is not set, group by category alone.
   *
   * The grouping key in the returned object is the category name (if there's
   * only one property group for that category) or "category:property" for
   * disambiguation when needed. To keep the output clean and match the spec,
   * we group by category and merge property sub-groups into the category.
   */
  private groupEntries(
    entries: CollectedEntry[]
  ): Record<string, CategorySummary> {
    // Step 1: Group by (category, property) tuple
    const groups = new Map<string, { count: number; category: string; property?: string }>();

    for (const entry of entries) {
      const key = entry.property
        ? `${entry.category}::${entry.property}`
        : entry.category;

      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, {
          count: 1,
          category: entry.category,
          property: entry.property,
        });
      }
    }

    // Step 2: Merge into per-category summaries
    // If multiple properties exist under the same category, we aggregate
    // the counts and pick the most frequent property for the sample message.
    const categoryGroups = new Map<
      string,
      { totalCount: number; subGroups: Array<{ count: number; property?: string }> }
    >();

    for (const group of groups.values()) {
      const existing = categoryGroups.get(group.category);
      if (existing) {
        existing.totalCount += group.count;
        existing.subGroups.push({ count: group.count, property: group.property });
      } else {
        categoryGroups.set(group.category, {
          totalCount: group.count,
          subGroups: [{ count: group.count, property: group.property }],
        });
      }
    }

    // Step 3: Build the result
    const result: Record<string, CategorySummary> = {};

    for (const [category, group] of categoryGroups) {
      // Pick the sub-group with the highest count for the sample message
      const topSubGroup = group.subGroups.sort((a, b) => b.count - a.count)[0];
      const sample = this.buildSampleMessage(
        group.totalCount,
        category,
        topSubGroup.property
      );

      result[category] = {
        count: group.totalCount,
        sample,
      };
    }

    return result;
  }

  /**
   * Build a human-readable sample message for a category group.
   */
  private buildSampleMessage(
    count: number,
    category: string,
    property?: string
  ): string {
    const desc = CATEGORY_DESCRIPTIONS[category] || category;

    if (property) {
      if (category === "required_null") {
        return `${count} rows have ${desc} '${property}'`;
      }
      return `${count} rows have ${desc} errors on the '${property}' property`;
    }

    // No property — generic message
    if (category === "primary_key") {
      return `${count} primary key values have leading/trailing whitespace`;
    }
    if (category === "file_read") {
      return `${count} file read errors occurred`;
    }
    if (category === "opensearch_rejection") {
      return `${count} documents were rejected by OpenSearch`;
    }

    return `${count} ${desc} errors occurred`;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default IndexingErrorCollector;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/errorCollector.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running errorCollector self-tests...\n");

  // =======================================================================
  // Test 1: Fresh collector — no errors, no warnings
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    assert(c.hasErrors() === false, "fresh: hasErrors is false");

    const summary = c.getSummary();
    assert(summary.errorCount === 0, "fresh: errorCount is 0");
    assert(summary.warningCount === 0, "fresh: warningCount is 0");
    assert(Object.keys(summary.errorsByCategory).length === 0, "fresh: no error categories");
    assert(Object.keys(summary.warningsByCategory).length === 0, "fresh: no warning categories");

    const report = c.getFullReport();
    assert(report.errors.length === 0, "fresh: 0 errors in report");
    assert(report.warnings.length === 0, "fresh: 0 warnings in report");
  }

  // =======================================================================
  // Test 2: Spec example — 15 type_conversion, 2 required_null, 3 warnings
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    // 15 type_conversion errors for "salary"
    for (let i = 1; i <= 15; i++) {
      c.addError("type_conversion", {
        row: i,
        property: "salary",
        value: `bad-val-${i}`,
        message: `Cannot convert 'bad-val-${i}' to type double`,
      });
    }

    // 2 required_null errors for "fullName"
    for (let i = 16; i <= 17; i++) {
      c.addError("required_null", {
        row: i,
        property: "fullName",
        message: `Required property 'fullName' has null/empty value`,
      });
    }

    // 3 primary_key whitespace warnings
    for (let i = 1; i <= 3; i++) {
      c.addWarning("primary_key", {
        row: i,
        message: `Primary key value has leading/trailing whitespace`,
      });
    }

    // hasErrors
    assert(c.hasErrors() === true, "spec: hasErrors is true");

    // getSummary
    const summary = c.getSummary();
    assert(summary.errorCount === 17, "spec: errorCount is 17");
    assert(summary.warningCount === 3, "spec: warningCount is 3");

    // Error categories
    assert("type_conversion" in summary.errorsByCategory, "spec: has type_conversion");
    assert(summary.errorsByCategory.type_conversion.count === 15, "spec: type_conversion count 15");
    assert(
      summary.errorsByCategory.type_conversion.sample.includes("salary"),
      `spec: type_conversion sample includes 'salary' (got: '${summary.errorsByCategory.type_conversion.sample}')`
    );
    assert(
      summary.errorsByCategory.type_conversion.sample.includes("15"),
      "spec: type_conversion sample includes '15'"
    );

    assert("required_null" in summary.errorsByCategory, "spec: has required_null");
    assert(summary.errorsByCategory.required_null.count === 2, "spec: required_null count 2");
    assert(
      summary.errorsByCategory.required_null.sample.includes("fullName"),
      `spec: required_null sample includes 'fullName' (got: '${summary.errorsByCategory.required_null.sample}')`
    );
    assert(
      summary.errorsByCategory.required_null.sample.includes("2"),
      "spec: required_null sample includes '2'"
    );

    // Warning categories
    assert("primary_key" in summary.warningsByCategory, "spec: has primary_key warning");
    assert(summary.warningsByCategory.primary_key.count === 3, "spec: primary_key warning count 3");
    assert(
      summary.warningsByCategory.primary_key.sample.includes("3"),
      "spec: primary_key warning sample includes '3'"
    );
    assert(
      summary.warningsByCategory.primary_key.sample.includes("whitespace"),
      `spec: primary_key warning sample includes 'whitespace' (got: '${summary.warningsByCategory.primary_key.sample}')`
    );

    // getFullReport
    const report = c.getFullReport();
    assert(report.errors.length === 17, "spec: 17 errors in report");
    assert(report.warnings.length === 3, "spec: 3 warnings in report");
    assert(report.summary.errorCount === 17, "spec: summary errorCount 17");
    assert(report.summary.warningCount === 3, "spec: summary warningCount 3");
  }

  // =======================================================================
  // Test 3: hasErrors only counts errors, not warnings
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addWarning("primary_key", { message: "whitespace" });
    c.addWarning("primary_key", { message: "whitespace" });

    assert(c.hasErrors() === false, "warnings only: hasErrors is false");
    assert(c.getSummary().warningCount === 2, "warnings only: warningCount is 2");
    assert(c.getSummary().errorCount === 0, "warnings only: errorCount is 0");
  }

  // =======================================================================
  // Test 4: Single error
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "File not found: /data/missing.csv" });

    assert(c.hasErrors() === true, "single: hasErrors true");

    const summary = c.getSummary();
    assert(summary.errorCount === 1, "single: errorCount 1");
    assert("file_read" in summary.errorsByCategory, "single: has file_read");
    assert(summary.errorsByCategory.file_read.count === 1, "single: file_read count 1");
  }

  // =======================================================================
  // Test 5: Error entry shape in full report
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("type_conversion", {
      row: 42,
      property: "salary",
      value: "not-a-number",
      message: "Cannot convert 'not-a-number' to type double",
    });

    const report = c.getFullReport();
    const err = report.errors[0];

    assert(err.category === "type_conversion", "entry shape: category");
    assert(err.row === 42, "entry shape: row");
    assert(err.property === "salary", "entry shape: property");
    assert(err.value === "not-a-number", "entry shape: value");
    assert(err.message === "Cannot convert 'not-a-number' to type double", "entry shape: message");
  }

  // =======================================================================
  // Test 6: Optional fields not present when not provided
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "disk error" });

    const err = c.getFullReport().errors[0];

    assert(!("row" in err), "optional: no row");
    assert(!("property" in err), "optional: no property");
    assert(!("value" in err), "optional: no value");
    assert(err.message === "disk error", "optional: message present");
    assert(err.category === "file_read", "optional: category present");
  }

  // =======================================================================
  // Test 7: Invalid category throws
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    let threwError = false;
    let errorMsg = "";
    try {
      c.addError("invalid_category" as ErrorCategory, { message: "test" });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError, "invalid cat error: throws");
    assert(
      errorMsg.includes("Invalid error category"),
      `invalid cat error: message (got: '${errorMsg}')`
    );
    assert(
      errorMsg.includes("invalid_category"),
      "invalid cat error: includes bad value"
    );
  }

  // =======================================================================
  // Test 8: Invalid category for warning throws
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    let threwError = false;
    try {
      c.addWarning("bad" as ErrorCategory, { message: "test" });
    } catch {
      threwError = true;
    }

    assert(threwError, "invalid cat warning: throws");
  }

  // =======================================================================
  // Test 9: Multiple categories in errors
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    c.addError("type_conversion", { row: 1, property: "age", message: "bad" });
    c.addError("required_null", { row: 2, property: "name", message: "null" });
    c.addError("primary_key", { row: 3, message: "dup" });
    c.addError("opensearch_rejection", { row: 4, message: "rejected" });
    c.addError("file_read", { message: "io error" });

    const summary = c.getSummary();
    assert(summary.errorCount === 5, "multi cat: errorCount 5");
    assert(Object.keys(summary.errorsByCategory).length === 5, "multi cat: 5 categories");
    assert("type_conversion" in summary.errorsByCategory, "multi cat: type_conversion");
    assert("required_null" in summary.errorsByCategory, "multi cat: required_null");
    assert("primary_key" in summary.errorsByCategory, "multi cat: primary_key");
    assert("opensearch_rejection" in summary.errorsByCategory, "multi cat: opensearch_rejection");
    assert("file_read" in summary.errorsByCategory, "multi cat: file_read");
  }

  // =======================================================================
  // Test 10: Dedup by (category, property) — same category different props
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    c.addError("type_conversion", { row: 1, property: "salary", message: "bad salary" });
    c.addError("type_conversion", { row: 2, property: "salary", message: "bad salary" });
    c.addError("type_conversion", { row: 3, property: "age", message: "bad age" });

    const summary = c.getSummary();
    // All 3 are type_conversion, so they're aggregated under one category key
    assert(summary.errorCount === 3, "dedup: errorCount 3");
    assert(summary.errorsByCategory.type_conversion.count === 3, "dedup: type_conversion count 3");
    // Sample should reference the most common property (salary with 2)
    assert(
      summary.errorsByCategory.type_conversion.sample.includes("salary"),
      `dedup: sample includes top property 'salary' (got: '${summary.errorsByCategory.type_conversion.sample}')`
    );
  }

  // =======================================================================
  // Test 11: getFullReport returns copies (not references)
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "test" });

    const r1 = c.getFullReport();
    const r2 = c.getFullReport();

    assert(r1.errors !== r2.errors, "copies: different array references");
    assert(r1.errors.length === r2.errors.length, "copies: same length");
  }

  // =======================================================================
  // Test 12: Errors and warnings are separate
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    c.addError("type_conversion", { row: 1, property: "x", message: "err" });
    c.addWarning("type_conversion", { row: 2, property: "x", message: "warn" });

    const summary = c.getSummary();
    assert(summary.errorCount === 1, "separate: 1 error");
    assert(summary.warningCount === 1, "separate: 1 warning");
    assert("type_conversion" in summary.errorsByCategory, "separate: error cat");
    assert("type_conversion" in summary.warningsByCategory, "separate: warning cat");
    assert(summary.errorsByCategory.type_conversion.count === 1, "separate: error count 1");
    assert(summary.warningsByCategory.type_conversion.count === 1, "separate: warning count 1");
  }

  // =======================================================================
  // Test 13: opensearch_rejection category
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    c.addError("opensearch_rejection", { row: 1, message: "mapper_parsing_exception" });
    c.addError("opensearch_rejection", { row: 2, message: "mapper_parsing_exception" });

    const summary = c.getSummary();
    assert(summary.errorsByCategory.opensearch_rejection.count === 2, "os rejection: count 2");
    assert(
      summary.errorsByCategory.opensearch_rejection.sample.includes("2"),
      "os rejection: sample includes count"
    );
    assert(
      summary.errorsByCategory.opensearch_rejection.sample.includes("rejected"),
      `os rejection: sample includes 'rejected' (got: '${summary.errorsByCategory.opensearch_rejection.sample}')`
    );
  }

  // =======================================================================
  // Test 14: Summary is included in full report
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "test" });

    const report = c.getFullReport();
    assert("summary" in report, "full report: has summary");
    assert(report.summary.errorCount === 1, "full report: summary errorCount");
  }

  // =======================================================================
  // Test 15: Large number of errors
  // =======================================================================
  {
    const c = new IndexingErrorCollector();

    for (let i = 0; i < 1000; i++) {
      c.addError("type_conversion", {
        row: i + 1,
        property: "salary",
        value: `bad-${i}`,
        message: `error ${i}`,
      });
    }

    assert(c.hasErrors() === true, "large: hasErrors true");
    assert(c.getSummary().errorCount === 1000, "large: errorCount 1000");
    assert(c.getFullReport().errors.length === 1000, "large: 1000 entries in report");
    assert(
      c.getSummary().errorsByCategory.type_conversion.count === 1000,
      "large: category count 1000"
    );
  }

  // =======================================================================
  // Test 16: All valid categories accepted
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    const categories: ErrorCategory[] = [
      "primary_key",
      "type_conversion",
      "required_null",
      "opensearch_rejection",
      "file_read",
    ];

    let allAccepted = true;
    for (const cat of categories) {
      try {
        c.addError(cat, { message: `test ${cat}` });
        c.addWarning(cat, { message: `warn ${cat}` });
      } catch {
        allAccepted = false;
      }
    }

    assert(allAccepted, "all cats: all accepted");
    assert(c.getSummary().errorCount === 5, "all cats: 5 errors");
    assert(c.getSummary().warningCount === 5, "all cats: 5 warnings");
  }

  // =======================================================================
  // Test 17: Return shape of getSummary
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    const summary = c.getSummary();

    assert("errorCount" in summary, "summary shape: has errorCount");
    assert("warningCount" in summary, "summary shape: has warningCount");
    assert("errorsByCategory" in summary, "summary shape: has errorsByCategory");
    assert("warningsByCategory" in summary, "summary shape: has warningsByCategory");
    assert(typeof summary.errorCount === "number", "summary shape: errorCount is number");
    assert(typeof summary.warningCount === "number", "summary shape: warningCount is number");
    assert(typeof summary.errorsByCategory === "object", "summary shape: errorsByCategory is object");
    assert(typeof summary.warningsByCategory === "object", "summary shape: warningsByCategory is object");
  }

  // =======================================================================
  // Test 18: Return shape of getFullReport
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    const report = c.getFullReport();

    assert("errors" in report, "report shape: has errors");
    assert("warnings" in report, "report shape: has warnings");
    assert("summary" in report, "report shape: has summary");
    assert(Array.isArray(report.errors), "report shape: errors is array");
    assert(Array.isArray(report.warnings), "report shape: warnings is array");
  }

  // =======================================================================
  // Test 19: CategorySummary shape
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "test" });

    const catSummary = c.getSummary().errorsByCategory.file_read;

    assert("count" in catSummary, "cat summary shape: has count");
    assert("sample" in catSummary, "cat summary shape: has sample");
    assert(typeof catSummary.count === "number", "cat summary shape: count is number");
    assert(typeof catSummary.sample === "string", "cat summary shape: sample is string");
  }

  // =======================================================================
  // Test 20: No property — category-only grouping
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "err 1" });
    c.addError("file_read", { message: "err 2" });

    const summary = c.getSummary();
    assert(summary.errorsByCategory.file_read.count === 2, "no prop: count 2");
    assert(
      summary.errorsByCategory.file_read.sample.includes("2"),
      "no prop: sample includes count"
    );
  }

  // =======================================================================
  // Test 21: Mixed errors with and without property in same category
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("primary_key", { row: 1, property: "empId", message: "dup key" });
    c.addError("primary_key", { row: 2, property: "empId", message: "dup key" });
    c.addError("primary_key", { row: 3, message: "missing key" });

    const summary = c.getSummary();
    assert(summary.errorsByCategory.primary_key.count === 3, "mixed prop: total count 3");
    // empId group has 2, no-prop group has 1 — sample should reference empId (the larger group)
    assert(
      summary.errorsByCategory.primary_key.sample.includes("empId"),
      `mixed prop: sample references top property (got: '${summary.errorsByCategory.primary_key.sample}')`
    );
  }

  // =======================================================================
  // Test 22: Collector preserves insertion order in full report
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("type_conversion", { row: 1, message: "first" });
    c.addError("required_null", { row: 2, message: "second" });
    c.addError("type_conversion", { row: 3, message: "third" });

    const report = c.getFullReport();
    assert(report.errors[0].message === "first", "order: first error");
    assert(report.errors[1].message === "second", "order: second error");
    assert(report.errors[2].message === "third", "order: third error");
  }

  // =======================================================================
  // Test 23: Warnings also preserve insertion order
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addWarning("primary_key", { row: 1, message: "w1" });
    c.addWarning("primary_key", { row: 2, message: "w2" });

    const report = c.getFullReport();
    assert(report.warnings[0].message === "w1", "warn order: first");
    assert(report.warnings[1].message === "w2", "warn order: second");
  }

  // =======================================================================
  // Test 24: Adding errors after getSummary still works
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("file_read", { message: "first" });

    const s1 = c.getSummary();
    assert(s1.errorCount === 1, "add after: first summary 1");

    c.addError("file_read", { message: "second" });

    const s2 = c.getSummary();
    assert(s2.errorCount === 2, "add after: second summary 2");
  }

  // =======================================================================
  // Test 25: type_conversion with property sample message format
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("type_conversion", { row: 1, property: "age", message: "bad" });

    const sample = c.getSummary().errorsByCategory.type_conversion.sample;
    assert(
      sample === "1 rows have type conversion errors on the 'age' property",
      `tc sample format: (got: '${sample}')`
    );
  }

  // =======================================================================
  // Test 26: required_null with property sample message format
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addError("required_null", { row: 1, property: "fullName", message: "null" });
    c.addError("required_null", { row: 2, property: "fullName", message: "null" });

    const sample = c.getSummary().errorsByCategory.required_null.sample;
    assert(
      sample === "2 rows have null values for required property 'fullName'",
      `rn sample format: (got: '${sample}')`
    );
  }

  // =======================================================================
  // Test 27: primary_key without property sample message format
  // =======================================================================
  {
    const c = new IndexingErrorCollector();
    c.addWarning("primary_key", { message: "ws" });
    c.addWarning("primary_key", { message: "ws" });
    c.addWarning("primary_key", { message: "ws" });

    const sample = c.getSummary().warningsByCategory.primary_key.sample;
    assert(
      sample === "3 primary key values have leading/trailing whitespace",
      `pk sample format: (got: '${sample}')`
    );
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll errorCollector tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
