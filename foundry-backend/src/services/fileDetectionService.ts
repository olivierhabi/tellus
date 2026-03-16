import * as fs from 'fs';

/** Number of bytes to read for detection */
const DETECTION_BYTES = 8192;

/** Common delimiters to test, ordered by frequency */
const DELIMITER_CANDIDATES = [',', '\t', '|', ';'] as const;

export type DetectedDelimiter = ',' | '\t' | '|' | ';';

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'ascii' | 'unknown';

export interface FileDetectionResult {
  encoding: DetectedEncoding;
  delimiter: DetectedDelimiter;
  hasHeader: boolean;
  lineCount: number;
  columnCount: number;
  columns: string[];
  confidence: number;
}

export class FileDetectionService {
  /**
   * Detect file type, encoding, delimiter, and validate headers
   * by reading the first 8KB of the file.
   */
  async detectFileType(filePath: string): Promise<FileDetectionResult> {
    // Read first 8KB as a buffer
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(DETECTION_BYTES);
      const { bytesRead } = await fd.read(buffer, 0, DETECTION_BYTES, 0);
      const rawBuffer = buffer.subarray(0, bytesRead);

      // Step 1: Detect encoding
      const encoding = this.detectEncoding(rawBuffer);

      // Step 2: Decode to string
      const content = this.decodeBuffer(rawBuffer, encoding);

      // Step 3: Split into lines
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

      if (lines.length === 0) {
        return {
          encoding,
          delimiter: ',',
          hasHeader: false,
          lineCount: 0,
          columnCount: 0,
          columns: [],
          confidence: 0,
        };
      }

      // Step 4: Detect delimiter
      const delimiter = this.detectDelimiter(lines);

      // Step 5: Parse the first line as potential header
      const headerFields = this.splitLine(lines[0], delimiter);

      // Step 6: Validate headers (check if first row looks like header vs data)
      const hasHeader = this.detectHeader(lines, delimiter);

      // Step 7: Determine columns
      const columns = hasHeader
        ? headerFields.map((h) => h.trim())
        : headerFields.map((_, i) => `column_${i + 1}`);

      // Compute confidence based on consistency of column counts
      const confidence = this.computeConfidence(lines, delimiter, columns.length);

      return {
        encoding,
        delimiter,
        hasHeader,
        lineCount: lines.length,
        columnCount: columns.length,
        columns,
        confidence,
      };
    } finally {
      await fd.close();
    }
  }

  /**
   * Detect encoding from BOM or byte patterns.
   */
  private detectEncoding(buffer: Buffer): DetectedEncoding {
    if (buffer.length < 2) return 'ascii';

    // Check for BOM (Byte Order Mark)
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer.length > 2 && buffer[2] === 0xbf) {
      return 'utf-8';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return 'utf-16le';
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'utf-16be';
    }

    // Check for UTF-8 multi-byte sequences
    let hasMultibyte = false;
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      if (byte > 127) {
        hasMultibyte = true;
        // Check for valid UTF-8 continuation bytes
        if ((byte & 0xe0) === 0xc0) {
          if (i + 1 < buffer.length && (buffer[i + 1] & 0xc0) === 0x80) {
            i += 1;
            continue;
          }
          return 'unknown';
        }
        if ((byte & 0xf0) === 0xe0) {
          if (
            i + 2 < buffer.length &&
            (buffer[i + 1] & 0xc0) === 0x80 &&
            (buffer[i + 2] & 0xc0) === 0x80
          ) {
            i += 2;
            continue;
          }
          return 'unknown';
        }
        if ((byte & 0xf8) === 0xf0) {
          if (
            i + 3 < buffer.length &&
            (buffer[i + 1] & 0xc0) === 0x80 &&
            (buffer[i + 2] & 0xc0) === 0x80 &&
            (buffer[i + 3] & 0xc0) === 0x80
          ) {
            i += 3;
            continue;
          }
          return 'unknown';
        }
      }
    }

    return hasMultibyte ? 'utf-8' : 'ascii';
  }

  /**
   * Decode a buffer using the detected encoding.
   */
  private decodeBuffer(buffer: Buffer, encoding: DetectedEncoding): string {
    switch (encoding) {
      case 'utf-16le':
        // Skip BOM if present
        return buffer.subarray(buffer[0] === 0xff ? 2 : 0).toString('utf16le');
      case 'utf-16be': {
        // Node doesn't natively support UTF-16BE, swap bytes
        const swapped = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length - 1; i += 2) {
          swapped[i] = buffer[i + 1];
          swapped[i + 1] = buffer[i];
        }
        return swapped.subarray(2).toString('utf16le');
      }
      case 'utf-8':
        // Skip BOM if present
        if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
          return buffer.subarray(3).toString('utf-8');
        }
        return buffer.toString('utf-8');
      default:
        return buffer.toString('utf-8');
    }
  }

  /**
   * Detect the most likely delimiter by counting occurrences across lines
   * and checking for consistency.
   */
  private detectDelimiter(lines: string[]): DetectedDelimiter {
    const sampleLines = lines.slice(0, Math.min(20, lines.length));

    let bestDelimiter: DetectedDelimiter = ',';
    let bestScore = -1;

    for (const delimiter of DELIMITER_CANDIDATES) {
      const counts = sampleLines.map((line) => {
        // Count delimiter occurrences outside of quoted fields
        return this.countDelimiters(line, delimiter);
      });

      // A good delimiter should have consistent counts across lines and > 0
      const nonZeroCounts = counts.filter((c) => c > 0);
      if (nonZeroCounts.length === 0) continue;

      // Check consistency: how many lines have the same count as the first line
      const mode = counts[0];
      const consistentCount = counts.filter((c) => c === mode).length;

      // Score = consistency * average count (prefer delimiters with more columns)
      const avgCount = nonZeroCounts.reduce((a, b) => a + b, 0) / nonZeroCounts.length;
      const score = (consistentCount / sampleLines.length) * avgCount;

      if (score > bestScore) {
        bestScore = score;
        bestDelimiter = delimiter;
      }
    }

    return bestDelimiter;
  }

  /**
   * Count delimiter occurrences in a line, respecting quoted fields.
   */
  private countDelimiters(line: string, delimiter: string): number {
    let count = 0;
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        count++;
      }
    }

    return count;
  }

  /**
   * Split a line by delimiter, respecting quoted fields.
   */
  private splitLine(line: string, delimiter: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    fields.push(current);
    return fields;
  }

  /**
   * Detect whether the first line is a header row.
   * Heuristic: headers tend to be non-numeric strings, while data rows
   * often contain numeric values.
   */
  private detectHeader(lines: string[], delimiter: string): boolean {
    if (lines.length < 2) return true; // Assume header if only one line

    const firstRow = this.splitLine(lines[0], delimiter);
    const secondRow = this.splitLine(lines[1], delimiter);

    // Count how many fields in each row look numeric
    const firstRowNumericCount = firstRow.filter(
      (f) => f.trim() !== '' && !isNaN(Number(f.trim()))
    ).length;

    const secondRowNumericCount = secondRow.filter(
      (f) => f.trim() !== '' && !isNaN(Number(f.trim()))
    ).length;

    // If the first row has significantly fewer numeric fields than the second,
    // it's likely a header
    if (firstRowNumericCount < secondRowNumericCount) return true;

    // If the first row fields are all unique and non-empty, likely a header
    const trimmedFields = firstRow.map((f) => f.trim()).filter((f) => f.length > 0);
    const uniqueFields = new Set(trimmedFields);
    if (uniqueFields.size === trimmedFields.length && trimmedFields.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Compute confidence score (0-1) based on column count consistency.
   */
  private computeConfidence(
    lines: string[],
    delimiter: string,
    expectedColumns: number
  ): number {
    if (lines.length <= 1 || expectedColumns === 0) return 1;

    const sampleLines = lines.slice(0, Math.min(50, lines.length));
    let consistentCount = 0;

    for (const line of sampleLines) {
      const fields = this.splitLine(line, delimiter);
      if (fields.length === expectedColumns) {
        consistentCount++;
      }
    }

    return consistentCount / sampleLines.length;
  }
}
