/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";

// `import.meta.glob` is a Vite transform, so this entry point ships as source.
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the Linq component with a `convex-test` instance.
 * @param name - The name it is installed under in convex.config.ts.
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "linq",
): ComponentApi {
  t.registerComponent(name, schema, modules);
  return componentsGeneric()[name] as unknown as ComponentApi;
}

export default { register, schema, modules };
