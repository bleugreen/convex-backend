import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { runSystemQuery } from "../../run.js";
import { deploymentFetch } from "../../utils/utils.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";
import {
  renderValidatorType,
  renderInferredType,
} from "./typeRendering.js";

const inputSchema = z.object({
  table: z
    .string()
    .optional()
    .describe(
      "Get detailed schema for a specific table. If omitted, returns summary of all tables.",
    ),
  detail: z
    .boolean()
    .optional()
    .describe("Show full schema for all tables. Default is summary mode."),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const outputSchema = z.string().describe("Formatted table schema information");

const description = `
List tables in a Convex deployment.

By default, returns a summary with table names and field/index counts.
Use table param to get full schema for a specific table.
Use detail=true to get full schema for all tables.
`.trim();

export const TablesTool: ConvexTool<typeof inputSchema, typeof outputSchema> = {
  name: "tables",
  description,
  inputSchema,
  outputSchema,
  handler: async (ctx, args) => {
    const { projectDir, deployment } =
      await ctx.resolveDeploymentWithAccessCheck(args.deployment);
    process.chdir(projectDir);
    const deploymentSelection = await getDeploymentSelection(ctx, ctx.options);
    const credentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
      deployment,
    );
    const schemaResponse: any = await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/frontend/getSchemas",
      componentPath: undefined,
      args: {},
    });
    const schema: Record<string, z.infer<typeof activeSchemaEntry>> = {};
    if (schemaResponse.active) {
      const parsed = activeSchema.parse(JSON.parse(schemaResponse.active));
      for (const table of parsed.tables) {
        schema[table.tableName] = table;
      }
    }
    const fetch = deploymentFetch(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
    });
    const response = await fetch("/api/shapes2", {});
    const shapesResult: Record<string, any> = await response.json();

    const allTablesSet = new Set([
      ...Object.keys(shapesResult),
      ...Object.keys(schema),
    ]);
    let allTables = Array.from(allTablesSet);
    allTables.sort();

    // Filter to single table if specified
    if (args.table) {
      if (!allTablesSet.has(args.table)) {
        return `Table "${args.table}" not found. Available tables: ${allTables.join(", ")}`;
      }
      allTables = [args.table];
    }

    // Determine if we should show detail view
    // Detail if: specific table requested OR detail=true
    const showDetail = args.table !== undefined || args.detail === true;

    if (!showDetail) {
      // Summary mode: compact list with field/index counts
      const output: string[] = [];
      for (const tableName of allTables) {
        const tableSchema = schema[tableName];
        const inferredSchema = shapesResult[tableName];

        const fieldCount = countFields(tableSchema?.documentType, inferredSchema);
        const indexCount =
          (tableSchema?.indexes?.length ?? 0) +
          (tableSchema?.searchIndexes?.length ?? 0) +
          (tableSchema?.vectorIndexes?.length ?? 0);

        const parts = [`${tableName}`];
        if (fieldCount > 0) parts.push(`${fieldCount} fields`);
        if (indexCount > 0) parts.push(`${indexCount} indexes`);

        output.push(parts.join(" - "));
      }
      return output.join("\n");
    }

    // Detail mode: full schema with fields, types, and indexes
    const output: string[] = [];
    for (const tableName of allTables) {
      output.push(`## ${tableName}`);
      const tableSchema = schema[tableName];
      const inferredSchema = shapesResult[tableName];

      // Render fields from declared or inferred schema
      const fields = renderFields(tableSchema?.documentType, inferredSchema);
      if (fields.length > 0) {
        output.push(...fields.map((f) => `  ${f}`));
      }

      // Render indexes
      if (tableSchema?.indexes && tableSchema.indexes.length > 0) {
        output.push("Indexes:");
        for (const idx of tableSchema.indexes) {
          const fieldList = idx.fields?.join(", ") ?? "";
          output.push(`  ${idx.name} [${fieldList}]`);
        }
      }

      // Render search indexes
      if (tableSchema?.searchIndexes && tableSchema.searchIndexes.length > 0) {
        output.push("Search indexes:");
        for (const idx of tableSchema.searchIndexes) {
          const searchField = idx.searchField ?? "";
          const filterFields = idx.filterFields?.join(", ") ?? "";
          output.push(
            `  ${idx.name} (search: ${searchField}${filterFields ? `, filter: ${filterFields}` : ""})`,
          );
        }
      }

      // Render vector indexes
      if (tableSchema?.vectorIndexes && tableSchema.vectorIndexes.length > 0) {
        output.push("Vector indexes:");
        for (const idx of tableSchema.vectorIndexes) {
          const vectorField = idx.vectorField ?? "";
          const filterFields = idx.filterFields?.join(", ") ?? "";
          output.push(
            `  ${idx.name} (vector: ${vectorField}${filterFields ? `, filter: ${filterFields}` : ""})`,
          );
        }
      }

      output.push(""); // blank line between tables
    }

    return output.join("\n").trim();
  },
};

/**
 * Count fields from schema/inferred types for summary view.
 */
function countFields(documentType: any, inferredSchema: any): number {
  if (documentType?.type === "object" && documentType.value) {
    return Object.keys(documentType.value).length;
  }
  if (inferredSchema?.type === "Object" && inferredSchema.fields) {
    return inferredSchema.fields.length;
  }
  return 0;
}

/**
 * Render fields from schema/inferred types into readable format.
 * Returns array of strings like "fieldName: type" or "fieldName?: type"
 */
function renderFields(documentType: any, inferredSchema: any): string[] {
  const fields: string[] = [];

  // Try to extract fields from declared schema first
  if (documentType?.type === "object" && documentType.value) {
    for (const [fieldName, fieldDef] of Object.entries<any>(
      documentType.value,
    )) {
      const isOptional = fieldDef.optional === true;
      const typeStr = renderValidatorType(fieldDef, {
        showObjectFieldTypes: true,
      });
      fields.push(`${fieldName}${isOptional ? "?" : ""}: ${typeStr}`);
    }
    return fields;
  }

  // Fall back to inferred schema
  if (inferredSchema?.type === "Object" && inferredSchema.fields) {
    for (const field of inferredSchema.fields) {
      const isOptional = field.optional === true;
      const typeStr = renderInferredType(field.shape);
      fields.push(`${field.fieldName}${isOptional ? "?" : ""}: ${typeStr}`);
    }
    return fields;
  }

  return fields;
}

const activeSchemaEntry = z.object({
  tableName: z.string(),
  indexes: z.array(z.any()),
  searchIndexes: z.array(z.any()),
  vectorIndexes: z.array(z.any()),
  documentType: z.any(),
});

const activeSchema = z.object({ tables: z.array(activeSchemaEntry) });
