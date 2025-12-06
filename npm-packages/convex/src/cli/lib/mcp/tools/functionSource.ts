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

When a function is specified, returns the full module source with the line number
where that function starts.

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

    return {
      source,
      ...(lineno !== undefined ? { lineno } : {}),
    };
  },
};
