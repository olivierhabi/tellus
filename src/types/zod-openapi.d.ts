// ---------------------------------------------------------------------------
// Module augmentation: add `.openapi()` to every Zod schema.
//
// `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi(z)` patches this
// method onto ZodType at runtime. This file is module-scoped (the leading
// `import "zod"` makes it a module), so `declare module "zod"` AUGMENTS the
// real zod types rather than replacing them.
// ---------------------------------------------------------------------------
import "zod";

declare module "zod" {
  interface ZodType {
    openapi(meta: Record<string, unknown>): this;
  }
}
