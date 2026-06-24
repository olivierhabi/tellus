// B3-C-15 wiring proof — asserts the If-Match guard inside
// `src/middleware/ifMatchV2.ts` is wired into the PUT path.
//
// We import the middleware directly (no HTTP spin-up) and call it with
// crafted request stubs. The `[GREEN]` marker is emitted only when:
//   - missing  If-Match header → throws PRECONDITION_REQUIRED (428)
//   - stale    If-Match header → throws PRECONDITION_FAILED   (412)
//   - matching If-Match header → returns silently
// If the guard is stashed (the b3-c15-proof.sh harness rewrites the
// function body to a no-op for the RED phase), every probe will return
// silently and the proof fails with `[RED]`.
import { requireIfMatchV2 } from '../src/middleware/ifMatchV2';

interface ReqStub { headers: Record<string, string | undefined>; }

function probe(label: string, headers: Record<string, string | undefined>, currentEtag: number, expectThrow: boolean, expectedCode?: string) {
  let threw = false;
  let code: string | undefined;
  let status: number | undefined;
  try {
    requireIfMatchV2({ headers } as unknown as ReqStub & any, currentEtag, 'b3-c15-proof');
  } catch (err) {
    threw = true;
    code = (err as { errorName?: string; code?: string }).errorName ?? (err as any).code;
    status = (err as { httpStatus?: number; status?: number }).httpStatus ?? (err as any).status;
  }
  if (expectThrow) {
    if (!threw) {
      console.log(`[RED] ${label}: expected guard to throw; got silent return`);
      return false;
    }
    if (expectedCode && code !== expectedCode) {
      console.log(`[RED] ${label}: expected error ${expectedCode}; got ${code} (status=${status})`);
      return false;
    }
    console.log(`[ok] ${label}: threw ${code} (status=${status})`);
    return true;
  }
  if (threw) {
    console.log(`[RED] ${label}: expected silent pass; got throw ${code}`);
    return false;
  }
  console.log(`[ok] ${label}: silent pass`);
  return true;
}

const r1 = probe('missing If-Match', {}, 5, true, 'PreconditionRequiredError');
const r2 = probe('malformed If-Match', { 'if-match': 'bogus' }, 5, true, 'InvalidArgumentError');
const r3 = probe('stale If-Match', { 'if-match': '"v3"' }, 5, true, 'PreconditionFailedError');
const r4 = probe('current If-Match', { 'if-match': '"v5"' }, 5, false);

if (r1 && r2 && r3 && r4) {
  console.log('[GREEN] B3-C-15 If-Match guard wired correctly');
  process.exit(0);
}
console.log('[RED] FAIL B3-C-15 If-Match wiring');
process.exit(2);
