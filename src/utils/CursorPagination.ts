/**
 * Cursor-based pagination utility.
 *
 * Uses base64url-encoded JSON cursors and the limit+1 strategy
 * to determine if there are more results.
 */

export interface CursorPayload {
  [key: string]: unknown;
}

export interface CursorPage<T> {
  data: T[];
  pageInfo: {
    hasMore: boolean;
    cursor: string | null;
    count: number;
  };
}

/**
 * Encode a cursor payload as a base64url JSON string.
 * Base64url uses - and _ instead of + and / (no padding).
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  // Convert to base64url: replace + with -, / with _, remove =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url cursor string back to a payload object.
 * Returns null if the cursor is invalid.
 */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    // Convert base64url back to base64
    let base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padding = base64.length % 4;
    if (padding === 2) base64 += '==';
    else if (padding === 3) base64 += '=';

    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

/**
 * Process query results using the limit+1 strategy.
 *
 * The caller should query for `limit + 1` rows. This function
 * determines if there are more results beyond the current page
 * and trims the results to the requested limit.
 *
 * @param results - The raw query results (queried with limit + 1)
 * @param limit - The requested page size
 * @param cursorFactory - Function to build a cursor from the last item
 * @returns CursorPage with data, hasMore flag, and next cursor
 */
export function processResults<T>(
  results: T[],
  limit: number,
  cursorFactory: (lastItem: T) => CursorPayload
): CursorPage<T> {
  const hasMore = results.length > limit;

  // Trim to the requested limit
  const data = hasMore ? results.slice(0, limit) : results;

  // Build the cursor from the last item in the trimmed results
  const cursor = data.length > 0
    ? encodeCursor(cursorFactory(data[data.length - 1]))
    : null;

  return {
    data,
    pageInfo: {
      hasMore,
      cursor,
      count: data.length,
    },
  };
}
