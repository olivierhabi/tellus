// ---------------------------------------------------------------------------
// B2 — saga state machine unit tests.
//
// Spec contracts proven:
//   B2-C-20  INIT → COMPASS_RESERVED on step1 success
//   B2-C-21  COMPASS_RESERVED → STEMMA_CREATED on step2 success
//   B2-C-22  STEMMA_CREATED → TEMPLATE_PUSHED on step3 success
//   B2-C-23  TEMPLATE_PUSHED → ACTIVE on step4 success
//   B2-C-24  Step failure → COMPENSATING with reverse-order compensations
//   B2-C-25  COMPENSATING + comp-succeeded → ROLLED_BACK
//   B2-C-26  COMPENSATING + comp-failed → INIT_FAILED (retriable)
//   B2-C-27  Terminal states are absorbing
//   B2-C-28  Out-of-order events throw IllegalSagaTransition
//   B2-C-29  Step1 failure → ROLLED_BACK directly (no compensation needed)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  IllegalSagaTransition,
  transition,
} from "../../../../src/services/codeRepository/saga/stateMachine";
import {
  SAGA_STATES,
  TERMINAL_STATES,
  isTerminal,
  type SagaEvent,
  type SagaState,
} from "../../../../src/services/codeRepository/saga/types";

describe("B2 — saga state machine: forward path", () => {
  it("B2-C-20: INIT + step1-succeeded → COMPASS_RESERVED", () => {
    const r = transition("INIT", {
      kind: "step-succeeded",
      step: "step1-compass-reserve",
    });
    expect(r.nextState).toBe("COMPASS_RESERVED");
    expect(r.compensations).toEqual([]);
    expect(r.isTerminal).toBe(false);
  });

  it("B2-C-21: COMPASS_RESERVED + step2-succeeded → STEMMA_CREATED", () => {
    const r = transition("COMPASS_RESERVED", {
      kind: "step-succeeded",
      step: "step2-stemma-create",
    });
    expect(r.nextState).toBe("STEMMA_CREATED");
    expect(r.compensations).toEqual([]);
  });

  it("B2-C-22: STEMMA_CREATED + step3-succeeded → TEMPLATE_PUSHED", () => {
    const r = transition("STEMMA_CREATED", {
      kind: "step-succeeded",
      step: "step3-template-push",
    });
    expect(r.nextState).toBe("TEMPLATE_PUSHED");
  });

  it("B2-C-23: TEMPLATE_PUSHED + step4-succeeded → ACTIVE (terminal)", () => {
    const r = transition("TEMPLATE_PUSHED", {
      kind: "step-succeeded",
      step: "step4-activate",
    });
    expect(r.nextState).toBe("ACTIVE");
    expect(r.isTerminal).toBe(true);
  });
});

describe("B2 — saga state machine: failure → compensation", () => {
  it("B2-C-29: INIT + step1-failed → ROLLED_BACK directly (no compensation)", () => {
    const r = transition("INIT", {
      kind: "step-failed",
      step: "step1-compass-reserve",
      errorName: "CodeRepos:ParentFolderNotFound",
    });
    expect(r.nextState).toBe("ROLLED_BACK");
    expect(r.compensations).toEqual([]);
    expect(r.isTerminal).toBe(true);
  });

  it("B2-C-24: COMPASS_RESERVED + step2-failed → COMPENSATING(release-compass)", () => {
    const r = transition("COMPASS_RESERVED", {
      kind: "step-failed",
      step: "step2-stemma-create",
      errorName: "Stemma:Internal",
    });
    expect(r.nextState).toBe("COMPENSATING");
    expect(r.compensations).toEqual(["step1-compass-reserve"]);
    expect(r.isTerminal).toBe(false);
  });

  it("B2-C-24: STEMMA_CREATED + step3-failed → COMPENSATING(stemma, compass) reverse-ordered", () => {
    const r = transition("STEMMA_CREATED", {
      kind: "step-failed",
      step: "step3-template-push",
      errorName: "CodeRepos:TemplateInitFailed",
    });
    expect(r.nextState).toBe("COMPENSATING");
    // Reverse-order: stemma first (most-recent), then compass.
    expect(r.compensations).toEqual([
      "step2-stemma-create",
      "step1-compass-reserve",
    ]);
  });

  it("B2-C-24: TEMPLATE_PUSHED + step4-failed → COMPENSATING(all 3)", () => {
    const r = transition("TEMPLATE_PUSHED", {
      kind: "step-failed",
      step: "step4-activate",
      errorName: "CodeRepos:Internal",
    });
    expect(r.nextState).toBe("COMPENSATING");
    expect(r.compensations).toEqual([
      "step3-template-push",
      "step2-stemma-create",
      "step1-compass-reserve",
    ]);
  });
});

describe("B2 — saga state machine: COMPENSATING resolution", () => {
  it("B2-C-25: COMPENSATING + compensation-succeeded → ROLLED_BACK", () => {
    const r = transition("COMPENSATING", {
      kind: "compensation-succeeded",
      step: "step1-compass-reserve",
    });
    expect(r.nextState).toBe("ROLLED_BACK");
    expect(r.isTerminal).toBe(true);
  });

  it("B2-C-26: COMPENSATING + compensation-failed → INIT_FAILED (retriable)", () => {
    const r = transition("COMPENSATING", {
      kind: "compensation-failed",
      step: "step2-stemma-create",
      errorName: "Stemma:Unavailable",
    });
    expect(r.nextState).toBe("INIT_FAILED");
    expect(r.isTerminal).toBe(true);
  });
});

describe("B2 — saga state machine: terminal absorption", () => {
  it.each(["ACTIVE", "ROLLED_BACK", "INIT_FAILED"] as const)(
    "B2-C-27: %s is absorbing — every transition throws",
    (terminal) => {
      const events: SagaEvent[] = [
        { kind: "step-succeeded", step: "step1-compass-reserve" },
        { kind: "step-succeeded", step: "step4-activate" },
        {
          kind: "step-failed",
          step: "step3-template-push",
          errorName: "x",
        },
        {
          kind: "compensation-succeeded",
          step: "step1-compass-reserve",
        },
        {
          kind: "compensation-failed",
          step: "step1-compass-reserve",
          errorName: "y",
        },
      ];
      for (const ev of events) {
        expect(() => transition(terminal, ev)).toThrow(IllegalSagaTransition);
      }
    },
  );

  it("isTerminal() agrees with TERMINAL_STATES", () => {
    for (const s of SAGA_STATES) {
      expect(isTerminal(s)).toBe(TERMINAL_STATES.has(s));
    }
  });
});

describe("B2 — saga state machine: invalid transitions throw", () => {
  it("B2-C-28: out-of-order step-succeeded throws", () => {
    // step3 success in INIT — caller skipped step1 + step2.
    expect(() =>
      transition("INIT", {
        kind: "step-succeeded",
        step: "step3-template-push",
      }),
    ).toThrow(IllegalSagaTransition);
  });

  it("B2-C-28: out-of-order step-failed throws", () => {
    // step1-failed in COMPASS_RESERVED — by definition, step1 already succeeded.
    expect(() =>
      transition("COMPASS_RESERVED", {
        kind: "step-failed",
        step: "step1-compass-reserve",
        errorName: "x",
      }),
    ).toThrow(IllegalSagaTransition);
  });

  it("B2-C-28: compensation event in non-COMPENSATING state throws", () => {
    expect(() =>
      transition("STEMMA_CREATED", {
        kind: "compensation-succeeded",
        step: "step1-compass-reserve",
      }),
    ).toThrow(IllegalSagaTransition);

    expect(() =>
      transition("INIT", {
        kind: "compensation-failed",
        step: "step1-compass-reserve",
        errorName: "x",
      }),
    ).toThrow(IllegalSagaTransition);
  });

  it("error class carries the code property", () => {
    try {
      transition("ACTIVE", {
        kind: "step-succeeded",
        step: "step1-compass-reserve",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalSagaTransition);
      expect((err as IllegalSagaTransition).code).toBe(
        "ILLEGAL_SAGA_TRANSITION",
      );
      expect((err as Error).name).toBe("IllegalSagaTransition");
    }
  });
});

describe("B2 — saga state machine: full happy path", () => {
  it("walks INIT → COMPASS_RESERVED → STEMMA_CREATED → TEMPLATE_PUSHED → ACTIVE", () => {
    let state: SagaState = "INIT";
    const path: SagaState[] = [state];

    state = transition(state, {
      kind: "step-succeeded",
      step: "step1-compass-reserve",
    }).nextState;
    path.push(state);

    state = transition(state, {
      kind: "step-succeeded",
      step: "step2-stemma-create",
    }).nextState;
    path.push(state);

    state = transition(state, {
      kind: "step-succeeded",
      step: "step3-template-push",
    }).nextState;
    path.push(state);

    state = transition(state, {
      kind: "step-succeeded",
      step: "step4-activate",
    }).nextState;
    path.push(state);

    expect(path).toEqual([
      "INIT",
      "COMPASS_RESERVED",
      "STEMMA_CREATED",
      "TEMPLATE_PUSHED",
      "ACTIVE",
    ]);
  });

  it("walks INIT → COMPASS_RESERVED → STEMMA_CREATED → COMPENSATING → ROLLED_BACK", () => {
    let state: SagaState = "INIT";

    state = transition(state, {
      kind: "step-succeeded",
      step: "step1-compass-reserve",
    }).nextState;

    state = transition(state, {
      kind: "step-succeeded",
      step: "step2-stemma-create",
    }).nextState;

    const failure = transition(state, {
      kind: "step-failed",
      step: "step3-template-push",
      errorName: "CodeRepos:TemplateInitFailed",
    });
    state = failure.nextState;
    expect(state).toBe("COMPENSATING");
    expect(failure.compensations).toEqual([
      "step2-stemma-create",
      "step1-compass-reserve",
    ]);

    state = transition(state, {
      kind: "compensation-succeeded",
      step: "step1-compass-reserve",
    }).nextState;
    expect(state).toBe("ROLLED_BACK");
  });
});
