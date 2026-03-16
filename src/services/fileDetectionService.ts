import * as fs from 'fs';

const DETECTION_BYTES = 8192;
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
  async detectFileType(filePath: string): Promise<FileDetectionResult> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(DETECTION_BYTES);
      const { bytesRead } = await fd.read(buffer, 0, DETECTION_BYTES, 0);
      const rawBuffer = buffer.subarray(0, bytesRead);
      const encoding = this.detectEncoding(rawBuffer);
      const content = this.decodeBuffer(rawBuffer, encoding);
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

      if (lines.length === 0) {
        return { encoding, delimiter: ',', hasHeader: false, lineCount: 0, columnCount: 0, columns: [], confidence: 0 };
      }

      const delimiter = this.detectDelimiter(lines);
      const headerFields = this.splitLine(lines[0], delimiter);
      const hasHeader = this.detectHeader(lines, delimiter);
      const columns = hasHeader
        ? headerFields.map((h) => h.trim())
        : headerFields.map((_, i) => `column_${i + 1}`);
      const confidence = this.computeConfidence(lines, delimiter, columns.length);

      return { encoding, delimiter, hasHeader, lineCount: lines.length, columnCount: columns.length, columns, confidence };
    } finally {
      await fd.close();
    }
  }

  private detectEncoding(buffer: Buffer): DetectedEncoding {
    if (buffer.length < 2) return 'ascii';
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer.length > 2 && buffer[2] === 0xbf) return 'utf-8';
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';

    let hasMultibyte = false;
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      if (byte > 127) {
        hasMultibyte = true;
        if ((byte & 0xe0) === 0xc0) {
          if (i + 1 < buffer.length && (buffer[i + 1] & 0xc0) === 0x80) { i += 1; continue; }
          return 'unknown';
        }
        if ((byte & 0xf0) === 0xe0) {
          if (i + 2 < buffer.length && (buffer[i + 1] & 0xc0) === 0x80 && (buffer[i + 2] & 0xc0) === 0x80) { i += 2; continue; }
          return 'unknown';
        }
        if ((byte & 0xf8) === 0xf0) {
          if (i + 3 < buffer.length && (buffer[i + 1] & 0xc0) === 0x80 && (buffer[i + 2] & 0xc0) === 0x80 && (buffer[i + 3] & 0xc0) === 0x80) { i += 3; continue; }
          return 'unknown';
        }
      }
    }
    return hasMultibyte ? 'utf-8' : 'ascii';
  }

  private decodeBuffer(buffer: Buffer, encoding: DetectedEncoding): string {
    switch (encoding) {
      case 'utf-16le':
        return buffer.subarray(buffer[0] === 0xff ? 2 : 0).toString('utf16le');
      case 'utf-16be': {
        const swapped = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length - 1; i += 2) {
          swapped[i] = buffer[i + 1];
          swapped[i + 1] = buffer[i];
        }
        return swapped.subarray(2).toString('utf16le');
      }
      case 'utf-8':
        if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
          return buffer.subarray(3).toString('utf-8');
        }
        return buffer.toString('utf-8');
      default:
        return buffer.toString('utf-8');
    }
  }

  private detectDelimiter(lines: string[]): DetectedDelimiter {
    const sampleLines = lines.slice(0, Math.min(20, lines.length));
    let bestDelimiter: DetectedDelimiter = ',';
    let bestScore = -1;

    for (const delimiter of DELIMITER_CANDIDATES) {
      const counts = sampleLines.map((line) => this.countDelimiters(line, delimiter));
      const nonZeroCounts = counts.filter((c) => c > 0);
      if (nonZeroCounts.length === 0) continue;
      const mode = counts[0];
      const consistentCount = counts.filter((c) => c === mode).length;
      const avgCount = nonZeroCounts.reduce((a, b) => a + b, 0) / nonZeroCounts.length;
      const score = (consistentCount / sampleLines.length) * avgCount;
      if (score > bestScore) {
        bestScore = score;
        bestDelimiter = delimiter;
      }
    }
    return bestDelimiter;
  }

  private countDelimiters(line: string, delimiter: string): number {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') { inQuotes = !inQuotes; }
      else if (char === delimiter && !inQuotes) { count++; }
    }
    return count;
  }

  private splitLine(line: string, delimiter: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (char === delimiter && !inQuotes) { fields.push(current); current = ''; }
      else { current += char; }
    }
    fields.push(current);
    return fields;
  }

  private detectHeader(lines: string[], delimiter: string): boolean {
    if (lines.length < 2) return true;
    const firstRow = this.splitLine(lines[0], delimiter);
    const secondRow = this.splitLine(lines[1], delimiter);
    const firstRowNumericCount = firstRow.filter((f) => f.trim() !== '' && !isNaN(Number(f.trim()))).length;
    const secondRowNumericCount = secondRow.filter((f) => f.trim() !== '' && !isNaN(Number(f.trim()))).length;
    if (firstRowNumericCount < secondRowNumericCount) return true;
    const trimmedFields = firstRow.map((f) => f.trim()).filter((f) => f.length > 0);
    const uniqueFields = new Set(trimmedFields);
    if (uniqueFields.size === trimmedFields.length && trimmedFields.length > 0) return true;
    return false;
  }

  private computeConfidence(lines: string[], delimiter: string, expectedColumns: number): number {
    if (lines.length <= 1 || expectedColumns === 0) return 1;
    const sampleLines = lines.slice(0, Math.min(50, lines.length));
    let consistentCount = 0;
    for (const line of sampleLines) {
      const fields = this.splitLine(line, delimiter);
      if (fields.length === expectedColumns) consistentCount++;
    }
    return consistentCount / sampleLines.length;
  }
}
