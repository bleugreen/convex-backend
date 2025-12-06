import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";
import { deploymentFetch } from "../../utils/utils.js";
import { runSystemQuery } from "../../run.js";

const inputSchema = z.object({
  identifier: z
    .string()
    .describe(
      "Module path (e.g., 'messages.js') or function identifier (e.g., 'messages:send').",
    ),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const outputSchema = z.object({
  source: z.string().nullable(),
  lineno: z.number().optional(),
  reason: z.string().optional(),
});

const description = `
Get the source code for a module or function in your Convex deployment.

Accepts either:
- Module path: "messages.js", "lib/helpers.js"
- Function identifier: "messages:send", "lib/helpers:formatDate"

When a function is specified, returns only that function's source code.

Returns null source with a reason if source is unavailable (e.g., generated modules).
`.trim();

type Module = {
  functions: Array<{
    name: string;
    lineno?: number;
    udfType: string;
  }>;
  sourcePackageId: string;
};

/**
 * Extract a function from source code given the handler's line number.
 *
 * The lineno from the API points to the `handler:` line inside the function,
 * not the outer `export const fn = query({` definition. We search backwards
 * to find the actual start, then forwards to find the matching close.
 *
 * Returns the extracted source and the actual start line number (1-indexed).
 */
function extractFunction(
  source: string,
  handlerLine: number,
): { source: string; startLine: number } {
  const lines = source.split("\n");
  // Lines are 1-indexed, array is 0-indexed
  const handlerIndex = handlerLine - 1;

  if (handlerIndex < 0 || handlerIndex >= lines.length) {
    return { source, startLine: 1 };
  }

  // Search backwards from handler line to find the function definition start.
  // Look for patterns like `export const fn = query({` or `export default query({`
  let startIndex = handlerIndex;
  for (let i = handlerIndex; i >= 0; i--) {
    const line = lines[i];
    // Match export const/let/var, or export default, followed by query/mutation/action/etc
    if (
      /^\s*export\s+(const|let|var|default)\s/.test(line) ||
      /^\s*(const|let|var)\s+\w+\s*=\s*(query|internalQuery|mutation|internalMutation|action|internalAction|httpAction)\s*\(/.test(
        line,
      )
    ) {
      startIndex = i;
      break;
    }
  }

  // Now count braces from startIndex to find the end
  let braceCount = 0;
  let foundStart = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      if (char === "{") {
        braceCount++;
        foundStart = true;
      } else if (char === "}") {
        braceCount--;
        if (foundStart && braceCount === 0) {
          return {
            source: lines.slice(startIndex, i + 1).join("\n"),
            startLine: startIndex + 1, // Convert back to 1-indexed
          };
        }
      }
    }
  }

  // If we didn't find a matching close brace, return from start to end
  return {
    source: lines.slice(startIndex).join("\n"),
    startLine: startIndex + 1,
  };
}

export const FunctionSourceTool: ConvexTool<
  typeof inputSchema,
  typeof outputSchema
> = {
  name: "functionSource",
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

    // Parse identifier - could be "messages.js" or "messages:send"
    const hasFunction = args.identifier.includes(":");
    let modulePath: string;
    let functionName: string | undefined;

    if (hasFunction) {
      const [path, fn] = args.identifier.split(":");
      modulePath = path.endsWith(".js") ? path : `${path}.js`;
      functionName = fn;
    } else {
      modulePath = args.identifier.endsWith(".js")
        ? args.identifier
        : `${args.identifier}.js`;
    }

    // Query modules list to validate and get metadata
    const modules = (await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/frontend/modules:list",
      componentPath: undefined,
      args: {},
    })) as [string, Module][];

    const moduleEntry = modules.find(([path]) => path === modulePath);
    if (!moduleEntry) {
      return {
        source: null,
        reason: `Module '${modulePath}' not found. Use functionSpec to see available modules.`,
      };
    }

    const [, moduleData] = moduleEntry;

    // If function specified, find its line number
    let lineno: number | undefined;
    if (functionName) {
      const fn = moduleData.functions.find((f) => f.name === functionName);
      if (!fn) {
        const available = moduleData.functions.map((f) => f.name).join(", ");
        return {
          source: null,
          reason: `Function '${functionName}' not found in ${modulePath}. Available: ${available}`,
        };
      }
      lineno = fn.lineno;
    }

    // Fetch source code
    const fetch = deploymentFetch(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
    });

    const response = await fetch(
      `/api/get_source_code?path=${encodeURIComponent(modulePath)}`,
      {
        method: "GET",
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        return {
          source: null,
          reason: "Source code not available for this module.",
        };
      }
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage: `HTTP error ${response.status}: ${await response.text()}`,
      });
    }

    const source = await response.json();

    if (source === null) {
      return {
        source: null,
        reason:
          "Source code not available (possibly a generated or system module).",
      };
    }

    // If a specific function was requested and we have its line number,
    // extract just that function's source
    if (functionName && lineno !== undefined) {
      const extracted = extractFunction(source, lineno);
      return {
        source: extracted.source,
        lineno: extracted.startLine,
      };
    }

    return { source };
  },
};
