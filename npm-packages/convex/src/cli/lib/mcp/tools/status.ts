import { RequestContext } from "../requestContext.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import { z } from "zod";
import { ConvexTool } from "./index.js";
import { deploymentDashboardUrlPage } from "../../../lib/dashboard.js";
import { getDeploymentSelection } from "../../../lib/deploymentSelection.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  projectDir: z.string(),
  deployments: z.array(
    z.object({
      kind: z.enum(["dev", "prod"]),
      url: z.string(),
      dashboardUrl: z.string().optional(),
    }),
  ),
  productionRunEnabled: z.boolean(),
});

const description = `
Get status information for the configured Convex project.

Returns the project directory, available deployments (dev and prod) with their
URLs and dashboard links, and whether production mutations are enabled.

Use this first to understand what deployments are available. By default, tools
operate on the dev deployment. Pass deployment="prod" to other tools to access
production data (read-only unless --dangerously-enable-production-run is set).
`.trim();

export const StatusTool: ConvexTool<typeof inputSchema, typeof outputSchema> = {
  name: "status",
  description,
  inputSchema,
  outputSchema,
  handler: async (ctx: RequestContext) => {
    const projectDir = ctx.options.projectDir ?? process.cwd();
    process.chdir(projectDir);

    const deploymentSelection = await getDeploymentSelection(ctx, ctx.options);

    const deployments: Array<{
      kind: "dev" | "prod";
      url: string;
      dashboardUrl?: string | undefined;
    }> = [];

    // Get dev deployment
    const devCredentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
      { kind: "ownDev" },
    );
    deployments.push({
      kind: "dev",
      url: devCredentials.url,
      dashboardUrl:
        devCredentials.deploymentFields?.deploymentName &&
        deploymentDashboardUrlPage(
          devCredentials.deploymentFields.deploymentName,
          "",
        ),
    });

    // Get prod deployment if available (cloud-hosted)
    if (
      !(
        deploymentSelection.kind === "existingDeployment" &&
        deploymentSelection.deploymentToActOn.deploymentFields === null
      )
    ) {
      try {
        const prodCredentials = await loadSelectedDeploymentCredentials(
          ctx,
          deploymentSelection,
          { kind: "prod" },
        );
        if (
          prodCredentials.deploymentFields?.deploymentName &&
          prodCredentials.deploymentFields.deploymentType
        ) {
          deployments.push({
            kind: "prod",
            url: prodCredentials.url,
            dashboardUrl: deploymentDashboardUrlPage(
              prodCredentials.deploymentFields.deploymentName,
              "",
            ),
          });
        }
      } catch {
        // No prod deployment available
      }
    }

    return {
      projectDir,
      deployments,
      productionRunEnabled: !!ctx.options.dangerouslyEnableProductionRun,
    };
  },
};
