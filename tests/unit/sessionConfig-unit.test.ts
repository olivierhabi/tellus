/**
 * sessionConfig-unit.test.ts — pure-unit coverage for the single session
 * lifetime knob (TELLUS_SESSION_MAX_AGE).
 *
 * These tests pin the parsing + clamping contract that the cookie
 * Max-Age and the FE-facing `sessionMaxAgeSeconds` both depend on. No
 * server, no Docker — exercised via the pure `parseDurationSeconds` /
 * `resolveSessionMaxAgeSeconds` exports.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDurationSeconds,
  resolveSessionMaxAgeSeconds,
  resolveSessionIdleTimeoutSeconds,
  DEFAULT_SESSION_MAX_AGE_SECONDS,
  MIN_SESSION_MAX_AGE_SECONDS,
  MAX_SESSION_MAX_AGE_SECONDS,
  DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
  MIN_SESSION_IDLE_TIMEOUT_SECONDS,
} from '../../src/config/sessionConfig';

describe('sessionConfig — parseDurationSeconds', () => {
  it('parses a bare integer as seconds', () => {
    expect(parseDurationSeconds('28800', 0)).toBe(28800);
  });

  it('parses each duration unit suffix', () => {
    expect(parseDurationSeconds('45s', 0)).toBe(45);
    expect(parseDurationSeconds('30m', 0)).toBe(30 * 60);
    expect(parseDurationSeconds('8h', 0)).toBe(8 * 3600);
    expect(parseDurationSeconds('7d', 0)).toBe(7 * 86400);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseDurationSeconds('  8H ', 0)).toBe(8 * 3600);
  });

  it('falls back on empty, undefined, or malformed input', () => {
    expect(parseDurationSeconds(undefined, 99)).toBe(99);
    expect(parseDurationSeconds('', 99)).toBe(99);
    expect(parseDurationSeconds('abc', 99)).toBe(99);
    expect(parseDurationSeconds('8x', 99)).toBe(99);
    expect(parseDurationSeconds('8h30m', 99)).toBe(99);
    expect(parseDurationSeconds('-5', 99)).toBe(99);
    expect(parseDurationSeconds('0', 99)).toBe(99); // non-positive → fallback
  });
});

describe('sessionConfig — resolveSessionMaxAgeSeconds', () => {
  it('defaults when the knob is unset', () => {
    expect(resolveSessionMaxAgeSeconds({})).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
  });

  it('honours a valid configured window', () => {
    expect(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: '2h' })).toBe(7200);
    expect(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: '900' })).toBe(900);
  });

  it('clamps below the floor up to MIN', () => {
    expect(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: '1s' })).toBe(
      MIN_SESSION_MAX_AGE_SECONDS,
    );
  });

  it('clamps above the ceiling down to MAX', () => {
    expect(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: '365d' })).toBe(
      MAX_SESSION_MAX_AGE_SECONDS,
    );
  });

  it('falls back to default on a malformed knob (no throw)', () => {
    expect(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: 'nonsense' })).toBe(
      DEFAULT_SESSION_MAX_AGE_SECONDS,
    );
  });
});

describe('sessionConfig — resolveSessionIdleTimeoutSeconds', () => {
  it('defaults to 30m when the knob is unset', () => {
    expect(resolveSessionIdleTimeoutSeconds({})).toBe(
      DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
    );
    expect(DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS).toBe(30 * 60);
  });

  it('honours a valid configured idle window', () => {
    expect(
      resolveSessionIdleTimeoutSeconds({ TELLUS_SESSION_IDLE_TIMEOUT: '15m' }),
    ).toBe(900);
    expect(
      resolveSessionIdleTimeoutSeconds({ TELLUS_SESSION_IDLE_TIMEOUT: '600' }),
    ).toBe(600);
  });

  it('clamps below the floor up to MIN', () => {
    expect(
      resolveSessionIdleTimeoutSeconds({ TELLUS_SESSION_IDLE_TIMEOUT: '5s' }),
    ).toBe(MIN_SESSION_IDLE_TIMEOUT_SECONDS);
  });

  it('caps the idle timeout at the absolute session window', () => {
    // A 2h idle timeout makes no sense against a 1h session — the session
    // dies first, so idle is clamped down to the session max-age.
    expect(
      resolveSessionIdleTimeoutSeconds(
        { TELLUS_SESSION_IDLE_TIMEOUT: '2h' },
        3600,
      ),
    ).toBe(3600);
  });

  it('derives the session cap from the same env bag when not passed', () => {
    // Idle 8h vs session 1h (from env) → clamped to 3600.
    expect(
      resolveSessionIdleTimeoutSeconds({
        TELLUS_SESSION_IDLE_TIMEOUT: '8h',
        TELLUS_SESSION_MAX_AGE: '1h',
      }),
    ).toBe(3600);
  });

  it('falls back to default on a malformed knob (no throw)', () => {
    expect(
      resolveSessionIdleTimeoutSeconds({ TELLUS_SESSION_IDLE_TIMEOUT: 'nonsense' }),
    ).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS);
  });
});
