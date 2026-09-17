// ---------------------------------------------------------------------------
// sandboxBoundary.ts — realm boundary for the Functions vm sandbox
// ---------------------------------------------------------------------------
// SECURITY BACKGROUND (Strix CWE-94 finding, Sept 2026): the sandbox used to
// hand HOST-realm objects (console shim, require shim, Ontology SDK, module,
// request input) directly into the guest context. `vm` contextifies the
// object into a fresh realm but does NOT cut the realm linkage of host
// functions passed in: `console.log.constructor` is the HOST Function
// constructor, so authored code could compile `"return process"` in the
// host realm and gain full host-process code execution (file read/write,
// child_process, process.mainModule.require of pg/typescript — all
// demonstrated live by the pentest).
//
// This module makes every value that crosses host→guest a Proxy whose traps
// are host code the guest can never obtain a reference to:
//   • `.constructor` / `__proto__` resolve to the GUEST realm's own
//     intrinsics — the host Function constructor is unreachable.
//   • Every property read, method call, and return value is re-sealed on
//     the way back into the guest; every argument and `this` is marshalled
//     back to host values on the way out (sealed leaves restored to their
//     originals, guest callbacks bridged so host→guest callback arguments
//     are sealed).
// Combined with `codeGeneration: { strings: false, wasm: false }` on the
// context (functionRuntime), the demonstrated constructor-chain escapes are
// closed: guest code can only ever compile strings with the GUEST Function
// constructor, which is codegen-disabled.
//
// HONEST POSTURE: this raises the bar from "trivially escapable" to "no
// known in-process vector", but a vm context still shares the heap with the
// host process. The declared boundary remains the FunctionExecutor seam —
// see functionExecutor.ts and
// docs/operations/automate-function-invocation-contract.md (Phase-B isolated
// execution). Do NOT treat this file as making vm a security boundary.
// ---------------------------------------------------------------------------

import vm from "vm";

export interface GuestBoundary {
  /** Wrap a host value so it can be handed to guest code without exposing
   * the host realm. Idempotent and identity-stable (WeakMap-cached). */
  sealForGuest<T>(value: T): T;
  /** Restore guest-visible values to host-side values: sealed leaves become
   * their originals, guest containers are copied host-side with functions
   * bridged, thenables and exotic objects pass through untouched. */
  unsealForHost(value: unknown): unknown;
}

export function createGuestBoundary(context: vm.Context): GuestBoundary {
  // Capture the GUEST realm's intrinsics once (identifier reads only — no
  // string compilation, so it is legal under codeGeneration.strings=false).
  const intrinsics = vm.runInContext(
    "({ fnCtor: Function, objProto: Object.prototype, fnProto: Function.prototype })",
    context,
  ) as { fnCtor: unknown; objProto: unknown; fnProto: unknown };

  // original(host value) → proxy(guest-visible)
  const proxyOf = new WeakMap<object, unknown>();
  // proxy → original
  const originalOf = new WeakMap<object, object>();
  // guest fn → host bridge (identity-stable per guest fn)
  const bridgeOf = new WeakMap<object, (...args: unknown[]) => unknown>();

  const isHostFunction = (f: unknown): f is (...args: unknown[]) => unknown =>
    typeof f === "function" && f instanceof Function;

  /** Host wrapper around a GUEST callback: seals `this` + args before the
   * guest function sees them. Host functions pass through untouched. */
  function bridge(f: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    const cached = bridgeOf.get(f);
    if (cached) return cached;
    const wrapper = function bridged(this: unknown, ...args: unknown[]): unknown {
      return f.apply(seal(this), args.map((a) => seal(a)));
    };
    bridgeOf.set(f, wrapper);
    return wrapper;
  }

  /** Marshal a value HOST-ward: restore sealed leaves, copy guest containers
   * (so the host never retains guest-realm objects with sealed leaves), pass
   * primitives/promises/exotics/functions through untouched. Guest functions
   * are NOT bridged here — bridging (with argument sealing) applies only to
   * guest callbacks passed as ARGUMENTS to host method calls, where the host
   * later invokes them with host-realm values. Host-side storage of guest
   * functions (module.exports) must keep the function object itself so
   * signature metadata (fn.toString) stays readable. */
  function unmarshal(value: unknown, seen: Map<unknown, unknown>): unknown {
    if (value === null) return value;
    const kind = typeof value;
    if (kind !== "object" && kind !== "function") return value;
    if (kind === "function") {
      const original = originalOf.get(value as object);
      return original !== undefined ? original : value;
    }
    const original = originalOf.get(value as object);
    if (original !== undefined) return original;
    // Guest/host promises and other thenables must keep their identity —
    // the host awaits them directly.
    const then = (value as { then?: unknown }).then;
    if (typeof then === "function") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value as object, out);
      for (const item of value) out.push(unmarshal(item, seen));
      return out;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object Map]" || tag === "[object Set]") {
      return unmarshalCollection(value as object, tag === "[object Map]", seen);
    }
    // Plain objects of ANY realm: proto is null or some realm's Object.prototype.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype) {
      // HOST-born plain object: it can only reach the host side without ever
      // crossing the boundary (e.g. a raw host promise resolution value), so
      // it holds no sealed leaves — keep identity for instanceof checks.
      return value;
    }
    if (proto === null || Object.getPrototypeOf(proto) === null) {
      const out: Record<PropertyKey, unknown> = {};
      seen.set(value, out);
      for (const key of Reflect.ownKeys(value as object)) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (d && "value" in d) out[key] = unmarshal(d.value, seen);
      }
      return out;
    }
    // Exotic guest objects (class instances, Dates, …) pass through as-is.
    return value;
  }

  /** Copy guest Maps/Sets host-ward with sealed leaves restored. */
  function unmarshalCollection(value: object, isMap: boolean, seen: Map<unknown, unknown>): unknown {
    if (isMap) {
      const out = new Map<unknown, unknown>();
      seen.set(value, out);
      for (const [k, v] of value as Map<unknown, unknown>) {
        out.set(unmarshal(k, seen), unmarshal(v, seen));
      }
      return out;
    }
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const item of value as Set<unknown>) out.add(unmarshal(item, seen));
    return out;
  }

  /** Marshal a value GUEST-ward: wrap host objects/functions in traps. */
  function seal(value: unknown): unknown {
    if (value === null) return value;
    const kind = typeof value;
    if (kind !== "object" && kind !== "function") return value;
    const cached = proxyOf.get(value as object);
    if (cached !== undefined) return cached;
    const target = value as object;
    const proxy =
      kind === "function"
        ? new Proxy(target, makeTraps(true))
        : new Proxy(target, makeTraps(false));
    proxyOf.set(target, proxy);
    originalOf.set(proxy, target);
    return proxy;
  }

  /** Marshals one call argument host-ward (functions: unwrap-or-bridge). */
  function marshalArg(a: unknown): unknown {
    if (typeof a !== "function") return unmarshal(a, new Map());
    const original = originalOf.get(a as object);
    if (original !== undefined) return original;
    return isHostFunction(a) ? a : bridge(a as (...args: unknown[]) => unknown);
  }

  function makeTraps(isFunction: boolean): ProxyHandler<object> {
    const traps: ProxyHandler<object> = {
      get(t: object, prop: PropertyKey): unknown {
        // The escape hatch this whole file exists to close: never let the
        // guest reach the HOST realm's constructors or prototypes. Point the
        // guest at its OWN intrinsics instead.
        if (prop === "constructor") return intrinsics.fnCtor;
        if (prop === "__proto__") return isFunction ? intrinsics.fnProto : intrinsics.objProto;
        // Receiver = raw target so class getters/methods run with the real `this`.
        return seal(Reflect.get(t, prop, t));
      },
      has(t: object, prop: PropertyKey): boolean {
        return Reflect.has(t, prop);
      },
      set(t: object, prop: PropertyKey, value: unknown): boolean {
        // Write-through (module.exports = …, exports.default = …) with the
        // value marshalled host-ward first.
        return Reflect.set(t, prop, unmarshal(value, new Map()), t);
      },
      deleteProperty(t: object, prop: PropertyKey): boolean {
        return Reflect.deleteProperty(t, prop);
      },
      ownKeys(t: object): ArrayLike<string | symbol> {
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t: object, prop: PropertyKey): PropertyDescriptor | undefined {
        const d = Reflect.getOwnPropertyDescriptor(t, prop);
        if (!d) return undefined;
        if (d.configurable) {
          return "value" in d
            ? { configurable: true, enumerable: d.enumerable, writable: d.writable !== false, value: seal(d.value) }
            : {
                configurable: true,
                enumerable: d.enumerable,
                get: d.get ? (seal(d.get) as () => unknown) : undefined,
                set: d.set ? (seal(d.set) as (v: unknown) => void) : undefined,
              };
        }
        if ("value" in d) {
          if (!d.writable) {
            // Proxy invariants force same-value for non-writable
            // non-configurable data properties; we may not swap in a sealed
            // twin and may never leak the raw host object — refuse instead.
            if (d.value !== null && (typeof d.value === "object" || typeof d.value === "function")) {
              throw new TypeError(
                "non-writable non-configurable object-valued properties are not exposed to the Functions sandbox",
              );
            }
            return { configurable: false, enumerable: d.enumerable, writable: false, value: d.value };
          }
          return { configurable: false, enumerable: d.enumerable, writable: true, value: seal(d.value) };
        }
        return {
          configurable: false,
          enumerable: d.enumerable,
          get: d.get ? (seal(d.get) as () => unknown) : undefined,
          set: d.set ? (seal(d.set) as (v: unknown) => void) : undefined,
        };
      },
      defineProperty(t: object, prop: PropertyKey, desc: PropertyDescriptor): boolean {
        const host: PropertyDescriptor = { ...desc };
        if ("value" in host) host.value = unmarshal(host.value, new Map());
        if (host.get !== undefined && typeof host.get === "function") host.get = marshalArg(host.get) as () => unknown;
        if (host.set !== undefined && typeof host.set === "function") host.set = marshalArg(host.set) as (v: unknown) => void;
        return Reflect.defineProperty(t, prop, host);
      },
      getPrototypeOf(t: object): object | null {
        return (isFunction ? intrinsics.fnProto : intrinsics.objProto) as object | null;
      },
      setPrototypeOf(): boolean {
        throw new TypeError("sandbox objects are sealed");
      },
      isExtensible(t: object): boolean {
        return Reflect.isExtensible(t);
      },
      preventExtensions(t: object): boolean {
        return Reflect.preventExtensions(t);
      },
    };
    if (!isFunction) return traps;
    return {
      ...traps,
      apply(t: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[]): unknown {
        const hostThis =
          thisArg === null || thisArg === undefined ? thisArg : unmarshal(thisArg, new Map());
        const hostArgs = args.map(marshalArg);
        try {
          return seal(Reflect.apply(t, hostThis, hostArgs));
        } catch (e) {
          // Host exceptions must not leak host Error objects either.
          throw seal(e);
        }
      },
      construct(t: new (...args: unknown[]) => unknown, args: unknown[]): object {
        const hostArgs = args.map(marshalArg);
        try {
          return seal(Reflect.construct(t, hostArgs, t)) as object;
        } catch (e) {
          throw seal(e);
        }
      },
    };
  }

  return {
    sealForGuest: (<T>(value: T): T => seal(value) as T),
    unsealForHost: (value: unknown): unknown => unmarshal(value, new Map()),
  };
}
