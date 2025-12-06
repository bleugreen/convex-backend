import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";
import { deploymentFetch } from "../../utils/utils.js";
import { FunctionExecution } from "../../apiTypes.js";
import { formatLogsAsText } from "../../logs.js";

const LOG_LEVELS = ["DEBUG", "LOG", "INFO", "WARN", "ERROR"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const inputSchema = z.object({
  cursor: z
    .number()
    .optional()
    .describe(
      "Cursor from a previous response to fetch only new logs. Omit to fetch the full log buffer.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum number of log entries to return. Defaults to 20."),
  level: z
    .enum(LOG_LEVELS)
    .optional()
    .describe(
      "Filter to entries with logs at or above this level. E.g., 'ERROR' shows only errors, 'WARN' shows warnings and errors.",
    ),
  function: z
    .string()
    .optional()
    .describe(
      "Filter to functions matching this pattern (regex). E.g., 'messages:' or 'api/.*'",
    ),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const outputSchema = z.object({
  entries: z.string(),
  newCursor: z.number(),
});

const logsResponseSchema = z.object({
  entries: z.array(z.any()),
  newCursor: z.number(),
});

const description = `
Fetch recent log entries from your Convex deployment.

Returns formatted UDF execution logs and a cursor for pagination.
Use the cursor to fetch the next batch of logs.
`.trim();

export const LogsTool: ConvexTool<typeof inputSchema, typeof outputSchema> = {
  name: "logs",
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

    const fetch = deploymentFetch(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
    });

    // Fetch logs from cursor (0 = full buffer, or from previous newCursor)
    const cursor = args.cursor ?? 0;
    const response = await fetch(`/api/stream_function_logs?cursor=${cursor}`, {
      method: "GET",
    });

    if (!response.ok) {
      return await ctx.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage: `HTTP error ${response.status}: ${await response.text()}`,
      });
    }

    const { entries, newCursor } = await response
      .json()
      .then(logsResponseSchema.parse);

    // Build function pattern filter
    let functionPattern: RegExp | null = null;
    if (args.function) {
      try {
        functionPattern = new RegExp(args.function);
      } catch {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage: `Invalid regex pattern: ${args.function}`,
        });
      }
    }

    // Filter entries and their log lines
    const filtered: FunctionExecution[] = [];
    for (const entry of entries as FunctionExecution[]) {
      // Filter by function pattern
      if (functionPattern && !functionPattern.test(entry.identifier)) {
        continue;
      }

      // Filter by log level
      if (args.level) {
        const filteredEntry = filterEntryByLevel(entry, args.level);
        if (filteredEntry) {
          filtered.push(filteredEntry);
        }
      } else {
        filtered.push(entry);
      }
    }

    // Take the last N entries (most recent)
    const limit = args.limit ?? 20;
    const limited = filtered.slice(-limit);

    return {
      entries: formatLogsAsText(limited, true),
      newCursor,
    };
  },
};

/**
 * Filter an entry to only include log lines at or above the specified level.
 * Returns the filtered entry, or null if no matching content.
 * Level hierarchy: DEBUG < LOG < INFO < WARN < ERROR
 */
function filterEntryByLevel(
  entry: FunctionExecution,
  minLevel: LogLevel,
): FunctionExecution | null {
  const levelIndex = LOG_LEVELS.indexOf(minLevel);
  const hasError = "error" in entry && entry.error;
  const errorMatches = hasError && levelIndex <= LOG_LEVELS.indexOf("ERROR");

  // Filter log lines to only those at or above minLevel
  const filteredLogLines = entry.logLines.filter((line) => {
    if (typeof line === "object" && "level" in line) {
      const lineLevel = line.level as LogLevel;
      return LOG_LEVELS.indexOf(lineLevel) >= levelIndex;
    }
    return false;
  });

  // If no matching log lines and no matching error, exclude entry
  if (filteredLogLines.length === 0 && !errorMatches) {
    return null;
  }

  // Return entry with filtered log lines
  return {
    ...entry,
    logLines: filteredLogLines,
  };
}
