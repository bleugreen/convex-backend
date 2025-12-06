import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { runSystemQuery } from "../../run.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";
import { renderValidatorType } from "./typeRendering.js";

const inputSchema = z.object({
  file: z
    .string()
    .optional()
    .describe(
      "Filter to functions from a specific file (e.g., 'documents.js', 'batch').",
    ),
  pattern: z
    .string()
    .optional()
    .describe("Regex pattern to filter function names."),
  signatures: z
    .boolean()
    .optional()
    .describe(
      "Include full argument and return type signatures. Default shows names only.",
    ),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const outputSchema = z.string().describe("Formatted function specifications");

const description = `
Get function metadata from a Convex deployment.

Returns functions grouped by file with type prefix (Q=Query, M=Mutation,
A=Action, H=HttpAction). By default shows names only; use signatures=true
for full argument and return types.
`.trim();

export const FunctionSpecTool: ConvexTool<
  typeof inputSchema,
  typeof outputSchema
> = {
  name: "functionSpec",
  description,
  inputSchema,
  outputSchema,
  handler: async (ctx, args) => {
    const { projectDir, deployment } = ctx.resolveDeployment(args.deployment);
    process.chdir(projectDir);
    const deploymentSelection = await getDeploymentSelection(ctx, ctx.options);
    const credentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
      deployment,
    );
    const result = await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/cli/modules:apiSpec",
      componentPath: undefined,
      args: {},
    });
    if (!result || !Array.isArray(result)) {
      return "No functions found in deployment.";
    }
    const functions = z.array(functionSpecSchema).parse(result);

    // Group functions by file
    const byFile = new Map<string, FunctionSpec[]>();
    for (const fn of functions) {
      // HttpActions group under "http", regular functions by their file path
      const filePath =
        fn.functionType === "HttpAction"
          ? "http"
          : fn.identifier.split(":")[0];
      if (!byFile.has(filePath)) {
        byFile.set(filePath, []);
      }
      byFile.get(filePath)!.push(fn);
    }

    // Filter by file if specified
    let fileFilter: string | null = null;
    if (args.file) {
      // Normalize file filter (remove .js/.ts extension if present)
      fileFilter = args.file.replace(/\.(js|ts)$/, "");
    }

    // Filter by pattern if specified
    let patternFilter: RegExp | null = null;
    if (args.pattern) {
      try {
        patternFilter = new RegExp(args.pattern);
      } catch {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage: `Invalid regex pattern: ${args.pattern}`,
        });
      }
    }

    // Sort file paths
    const sortedFiles = Array.from(byFile.keys()).sort();

    // Render output
    const output: string[] = [];
    for (const filePath of sortedFiles) {
      // Apply file filter
      if (fileFilter && !filePath.includes(fileFilter)) {
        continue;
      }

      const fileFunctions = byFile.get(filePath)!;

      // Apply pattern filter
      const filteredFunctions = patternFilter
        ? fileFunctions.filter((fn) => {
            if (fn.functionType === "HttpAction") {
              return patternFilter!.test(fn.path);
            }
            return patternFilter!.test(fn.identifier);
          })
        : fileFunctions;

      if (filteredFunctions.length === 0) {
        continue;
      }

      output.push(`## ${filePath}`);

      for (const fn of filteredFunctions) {
        if (fn.functionType === "HttpAction") {
          // HTTP routes show method and path
          output.push(`H ${fn.method} ${fn.path}`);
        } else {
          const exportName = fn.identifier.split(":")[1];
          const typePrefix = getTypePrefix(fn.functionType);
          const visibility = fn.visibility?.kind === "internal" ? " (internal)" : "";

          if (args.signatures) {
            const argsStr = renderArgs(fn.args);
            const returnStr = renderReturnType(fn.returns);
            // Omit "-> any" as it's noise
            const returnPart = returnStr === "any" ? "" : ` -> ${returnStr}`;
            output.push(`${typePrefix} ${exportName}(${argsStr})${returnPart}${visibility}`);
          } else {
            output.push(`${typePrefix} ${exportName}${visibility}`);
          }
        }
      }

      output.push(""); // blank line between files
    }

    if (output.length === 0) {
      if (fileFilter) {
        return `No functions found matching file filter: ${args.file}`;
      }
      if (patternFilter) {
        return `No functions found matching pattern: ${args.pattern}`;
      }
      return "No functions found in deployment.";
    }

    return output.join("\n").trim();
  },
};

// Regular functions have identifier, visibility, args, returns
const regularFunctionSchema = z.object({
  identifier: z.string(),
  functionType: z.enum(["Query", "Mutation", "Action"]),
  visibility: z.object({ kind: z.enum(["public", "internal"]) }).nullable(),
  args: z.any().optional(),
  returns: z.any().optional(),
});

// HTTP actions have method and path instead
const httpFunctionSchema = z.object({
  functionType: z.literal("HttpAction"),
  method: z.string(),
  path: z.string(),
});

const functionSpecSchema = z.union([regularFunctionSchema, httpFunctionSchema]);

type FunctionSpec = z.infer<typeof functionSpecSchema>;

function getTypePrefix(
  functionType: "Query" | "Mutation" | "Action" | "HttpAction",
): string {
  switch (functionType) {
    case "Query":
      return "Q";
    case "Mutation":
      return "M";
    case "Action":
      return "A";
    case "HttpAction":
      return "H";
    default:
      return "?";
  }
}

function renderArgs(argsValidator: any): string {
  if (!argsValidator) return "";

  // Handle object validators (most common for args)
  if (argsValidator.type === "object" && argsValidator.value) {
    const args: string[] = [];
    for (const [name, validator] of Object.entries<any>(argsValidator.value)) {
      const isOptional = validator.optional === true;
      const typeStr = renderValidatorType(validator, { unknownTable: "?" });
      args.push(`${name}${isOptional ? "?" : ""}: ${typeStr}`);
    }
    return args.join(", ");
  }

  return "...";
}

function renderReturnType(returnValidator: any): string {
  if (!returnValidator) return "any";
  return renderValidatorType(returnValidator, { unknownTable: "?" });
}
