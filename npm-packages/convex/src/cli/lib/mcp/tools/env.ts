import { z } from "zod";
import { ConvexTool } from "./index.js";
import { loadSelectedDeploymentCredentials } from "../../api.js";
import {
  envSetInDeployment,
  envRemoveInDeployment,
  EnvVar,
} from "../../env.js";
import { runSystemQuery } from "../../run.js";
import { getDeploymentSelection } from "../../deploymentSelection.js";

// List Environment Variables
const envListInputSchema = z.object({
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const envListOutputSchema = z.string();

export const EnvListTool: ConvexTool<
  typeof envListInputSchema,
  typeof envListOutputSchema
> = {
  name: "envList",
  description: "List all environment variables in your Convex deployment.",
  inputSchema: envListInputSchema,
  outputSchema: envListOutputSchema,
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
    const variables = (await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/cli/queryEnvironmentVariables",
      componentPath: undefined,
      args: {},
    })) as EnvVar[];

    if (variables.length === 0) {
      return "No environment variables configured.";
    }

    return variables.map((v) => `${v.name}=${v.value}`).join("\n");
  },
};

// Get Environment Variable
const envGetInputSchema = z.object({
  name: z
    .string()
    .describe("The name of the environment variable to retrieve."),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe("Target deployment: 'dev' or 'prod'. Defaults to 'dev'."),
});

const envGetOutputSchema = z.object({
  value: z.union([z.string(), z.null()]),
});

export const EnvGetTool: ConvexTool<
  typeof envGetInputSchema,
  typeof envGetOutputSchema
> = {
  name: "envGet",
  description:
    "Get a specific environment variable from your Convex deployment.",
  inputSchema: envGetInputSchema,
  outputSchema: envGetOutputSchema,
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
    const envVar = (await runSystemQuery(ctx, {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      functionName: "_system/cli/queryEnvironmentVariables:get",
      componentPath: undefined,
      args: { name: args.name },
    })) as { name: string; value: string } | null;
    return { value: envVar?.value ?? null };
  },
};

// Set Environment Variable
const envSetInputSchema = z.object({
  name: z.string().describe("The name of the environment variable to set."),
  value: z.string().describe("The value to set for the environment variable."),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe(
      "Target deployment: 'dev' or 'prod'. Defaults to 'dev'. Modifying prod requires --dangerously-enable-production-mutations flag.",
    ),
});

const envSetOutputSchema = z.object({
  success: z.boolean(),
});

export const EnvSetTool: ConvexTool<
  typeof envSetInputSchema,
  typeof envSetOutputSchema
> = {
  name: "envSet",
  description: "Set an environment variable in your Convex deployment.",
  inputSchema: envSetInputSchema,
  outputSchema: envSetOutputSchema,
  handler: async (ctx, args) => {
    const { projectDir, deployment } =
      await ctx.resolveDeploymentWithAccessCheck(args.deployment);

    // Mutations on production require additional opt-in
    if (deployment.kind === "prod") {
      await ctx.assertProductionMutationsEnabled();
    }

    process.chdir(projectDir);
    const deploymentSelection = await getDeploymentSelection(ctx, ctx.options);
    const credentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
      deployment,
    );
    const deploymentInfo = {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      deploymentNotice: "",
    };
    await envSetInDeployment(ctx, deploymentInfo, args.name, args.value);
    return { success: true };
  },
};

// Remove Environment Variable
const envRemoveInputSchema = z.object({
  name: z.string().describe("The name of the environment variable to remove."),
  deployment: z
    .enum(["dev", "prod"])
    .optional()
    .describe(
      "Target deployment: 'dev' or 'prod'. Defaults to 'dev'. Modifying prod requires --dangerously-enable-production-mutations flag.",
    ),
});

const envRemoveOutputSchema = z.object({
  success: z.boolean(),
});

export const EnvRemoveTool: ConvexTool<
  typeof envRemoveInputSchema,
  typeof envRemoveOutputSchema
> = {
  name: "envRemove",
  description: "Remove an environment variable from your Convex deployment.",
  inputSchema: envRemoveInputSchema,
  outputSchema: envRemoveOutputSchema,
  handler: async (ctx, args) => {
    const { projectDir, deployment } =
      await ctx.resolveDeploymentWithAccessCheck(args.deployment);

    // Mutations on production require additional opt-in
    if (deployment.kind === "prod") {
      await ctx.assertProductionMutationsEnabled();
    }

    process.chdir(projectDir);
    const deploymentSelection = await getDeploymentSelection(ctx, ctx.options);
    const credentials = await loadSelectedDeploymentCredentials(
      ctx,
      deploymentSelection,
      deployment,
    );
    const deploymentInfo = {
      deploymentUrl: credentials.url,
      adminKey: credentials.adminKey,
      deploymentNotice: "",
    };
    await envRemoveInDeployment(ctx, deploymentInfo, args.name);
    return { success: true };
  },
};
