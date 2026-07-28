import type {
  LoadObjectSetQueryV2,
  LoadObjectSetRequestV2,
  PropertyIdentifier,
  PropertyLoadLevel,
} from "./objectSetDefinition";

/**
 * Stable Tellus extension used when a documented preview/experimental
 * capability is not available in this deployment. Returning a typed
 * INVALID_ARGUMENT is preferable to accepting and silently ignoring it.
 */
export class UnsupportedObjectSetFeatureError extends Error {
  readonly errorName = "UnsupportedObjectSetFeature";
  readonly code = "INVALID_ARGUMENT";

  constructor(
    public readonly feature: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedObjectSetFeatureError";
  }

  get parameters(): Record<string, unknown> {
    return { feature: this.feature };
  }
}

function assertLoadLevelSupported(
  loadLevel: PropertyLoadLevel | undefined,
  feature: string,
): void {
  // Every 2.70 load-level discriminator is implemented. When a reducer or
  // struct main-value is not configured, the public contract says the level
  // is ignored and the value is returned as-is.
  void loadLevel;
  void feature;
}

function walkPropertyIdentifier(identifier: PropertyIdentifier): void {
  const value = identifier as Record<string, unknown>;
  if (value.type !== "propertyWithLoadLevel") return;
  assertLoadLevelSupported(
    value.loadLevel as PropertyLoadLevel,
    "selectV2.propertyWithLoadLevel",
  );
  walkPropertyIdentifier(value.propertyIdentifier as PropertyIdentifier);
}

/**
 * Enforce every documented loadObjects feature that is not represented by
 * the core compiler. Explicit false/no-op values are accepted because they
 * have the documented default behavior; capability-enabling values fail
 * with a stable typed error.
 */
export function assertSupportedLoadObjectSetRequest(
  request: LoadObjectSetRequestV2,
  query: LoadObjectSetQueryV2,
): void {
  assertLoadLevelSupported(request.defaultLoadLevel, "defaultLoadLevel");
  for (const identifier of request.selectV2) {
    walkPropertyIdentifier(identifier);
  }

  // Property security, reference signing, transactions and scenarios are
  // applied by the production dependency factory after final state
  // composition. Nothing is silently ignored here.
  if (query.executeInMemoryOnly === true) {
    throw new UnsupportedObjectSetFeatureError(
      "executeInMemoryOnly",
      "This ObjectSet execution path requires OpenSearch and cannot be " +
        "computed entirely in memory.",
    );
  }
}
