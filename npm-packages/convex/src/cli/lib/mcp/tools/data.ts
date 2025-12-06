import { z } from "zod";
import { runSystemQuery } from "../../run.js";
import { ConvexTool } from "./index.js";
import { PaginationResult } from "../../../../server/pagination.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";

// Cursor cache - stores actual cursor strings, returns simple IDs
const cursorCache = new Map<number, string>();
let nextCursorId = 1;
const MAX_CACHED_CURSORS = 100;

function storeCursor(cursor: string): number {
  // Simple LRU: if cache is full, remove oldest entries
  if (cursorCache.size >= MAX_CACHED_CURSORS) {
    const oldestKey = cursorCache.keys().next().value;
    if (oldestKey !== undefined) {
      cursorCache.delete(oldestKey);
    }
  }
  const id = nextCursorId++;
  cursorCache.set(id, cursor);
  return id;
}

function getCursor(id: number): string | undefined {
  return cursorCache.get(id);
}

const inputSchema = z.object({
  tableName: z.string().describe("The name of the table to read from."),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Sort order. Defaults to 'desc' (newest first)."),
  cursor: z
    .number()
    .optional()
    .describe("Cursor ID from a previous response to fetch the next page."),
  limit: z
    .number()
    .max(1000)
    .optional()
    .describe("Maximum results to return. Defaults to 100."),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const outputSchema = z.object({
  page: z.array(z.any()),
  isDone: z.boolean(),
  nextCursor: z.number().optional(),
});

const description = `
Read a page of data from a table in the project's Convex deployment.

Output:
- page: Documents with _creationTime as ISO timestamps
- isDone: Whether there are more results to read
- nextCursor: Cursor ID for fetching the next page (omitted if done)
`.trim();

export const DataTool: ConvexTool<typeof inputSchema, typeof outputSchema> = {
  name: "data",
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

    // Look up actual cursor from cache if provided
    let actualCursor: string | null = null;
    if (args.cursor !== undefined) {
      const cached = getCursor(args.cursor);
      if (!cached) {
        return await ctx.crash({
          exitCode: 1,
          errorType: "fatal",
          printedMessage: `Invalid cursor ID: ${args.cursor}. Cursor may have expired.`,
        });
      }
      actualCursor = cached;
    }

    const paginationResult = (await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/cli/tableData",
      componentPath: undefined,
      args: {
        table: args.tableName,
        order: args.order ?? "desc",
        paginationOpts: {
          numItems: args.limit ?? 100,
          cursor: actualCursor,
        },
      },
    })) as unknown as PaginationResult<any>;

    // Convert _creationTime to ISO format for readability
    const page = paginationResult.page.map((doc: any) => {
      if (doc._creationTime && typeof doc._creationTime === "number") {
        return {
          ...doc,
          _creationTime: new Date(doc._creationTime).toISOString(),
        };
      }
      return doc;
    });

    // Store cursor and return ID (only if not done)
    const result: {
      page: any[];
      isDone: boolean;
      nextCursor?: number;
    } = {
      page,
      isDone: paginationResult.isDone,
    };

    if (!paginationResult.isDone) {
      result.nextCursor = storeCursor(paginationResult.continueCursor);
    }

    return result;
  },
};
