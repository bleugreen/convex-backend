/**
 * Shared utilities for rendering Convex validator types to readable strings.
 */

export interface RenderOptions {
  /** For Id types, what to show when tableName is missing */
  unknownTable?: string;
  /** For object types, whether to show field types (true) or just names (false) */
  showObjectFieldTypes?: boolean;
}

const defaultOptions: RenderOptions = {
  unknownTable: "unknown",
  showObjectFieldTypes: false,
};

/**
 * Render a declared schema validator type to a readable string.
 * Used by both functionSpec (for function signatures) and tables (for schema display).
 */
export function renderValidatorType(
  validator: any,
  options: RenderOptions = {},
): string {
  const opts = { ...defaultOptions, ...options };

  if (!validator) return "any";

  const v = validator.fieldType ?? validator;

  switch (v.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "bigint":
      return "bigint";
    case "bytes":
      return "bytes";
    case "any":
      return "any";
    case "id":
      return `Id<${v.tableName ?? opts.unknownTable}>`;
    case "array":
      return `${renderValidatorType(v.value, opts)}[]`;
    case "object":
      if (v.value && Object.keys(v.value).length > 0) {
        if (opts.showObjectFieldTypes) {
          const props = Object.entries<any>(v.value)
            .slice(0, 3)
            .map(([k, fieldV]) => `${k}: ${renderValidatorType(fieldV, opts)}`)
            .join(", ");
          const more = Object.keys(v.value).length > 3 ? ", ..." : "";
          return `{${props}${more}}`;
        } else {
          const fields = Object.keys(v.value).slice(0, 3);
          const more = Object.keys(v.value).length > 3 ? ", ..." : "";
          return `{${fields.join(", ")}${more}}`;
        }
      }
      return "object";
    case "union":
      if (v.value && v.value.length <= 3) {
        return v.value
          .map((u: any) => renderValidatorType(u, opts))
          .join(" | ");
      }
      return "union";
    case "literal":
      return JSON.stringify(v.value);
    default:
      return v.type ?? "any";
  }
}

/**
 * Render an inferred schema type (from shapes2 API) to a readable string.
 * The inferred schema uses different type names (e.g., "String" vs "string").
 */
export function renderInferredType(shape: any): string {
  if (!shape) return "unknown";

  switch (shape.type) {
    case "String":
      return "string";
    case "Int64":
    case "Float64":
      return "number";
    case "Boolean":
      return "boolean";
    case "Null":
      return "null";
    case "Id":
      return `Id<${shape.tableName ?? "unknown"}>`;
    case "Array":
      return `${renderInferredType(shape.shape)}[]`;
    case "Object":
      return "object";
    case "Union":
      if (shape.shapes && shape.shapes.length <= 3) {
        return shape.shapes.map((s: any) => renderInferredType(s)).join(" | ");
      }
      return "union";
    default:
      return shape.type ?? "unknown";
  }
}
