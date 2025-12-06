import { BigBrainAuth, Context, ErrorType } from "../../../bundler/context.js";
import { Filesystem, nodeFs } from "../../../bundler/fs.js";
import { Ora } from "ora";
import {
  DeploymentSelectionWithinProject,
  DeploymentSelectionOptions,
} from "../api.js";

export interface McpOptions extends DeploymentSelectionOptions {
  projectDir?: string;
  disableTools?: string;
  disableProduction?: boolean;
  dangerouslyEnableProductionMutations?: boolean;
  deployment?: "dev" | "prod" | undefined;
}

export class RequestContext implements Context {
  fs: Filesystem;
  deprecationMessagePrinted = false;
  spinner: Ora | undefined;
  _cleanupFns: Record<string, (exitCode: number, err?: any) => Promise<void>> =
    {};
  _bigBrainAuth: BigBrainAuth | null = null;
  constructor(public options: McpOptions) {
    this.fs = nodeFs;
    this.deprecationMessagePrinted = false;
  }

  async crash(args: {
    exitCode: number;
    errorType?: ErrorType;
    errForSentry?: any;
    printedMessage: string | null;
  }): Promise<never> {
    const cleanupFns = this._cleanupFns;
    this._cleanupFns = {};
    for (const fn of Object.values(cleanupFns)) {
      await fn(args.exitCode, args.errForSentry);
    }
    // eslint-disable-next-line no-restricted-syntax
    throw new RequestCrash(args.exitCode, args.errorType, args.printedMessage);
  }

  flushAndExit() {
    // eslint-disable-next-line no-restricted-syntax
    throw new Error("Not implemented");
  }

  registerCleanup(fn: (exitCode: number, err?: any) => Promise<void>): string {
    const handle = crypto.randomUUID();
    this._cleanupFns[handle] = fn;
    return handle;
  }

  removeCleanup(handle: string) {
    const value = this._cleanupFns[handle];
    delete this._cleanupFns[handle];
    return value ?? null;
  }

  bigBrainAuth(): BigBrainAuth | null {
    return this._bigBrainAuth;
  }

  _updateBigBrainAuth(auth: BigBrainAuth | null): void {
    this._bigBrainAuth = auth;
  }

  /**
   * Resolve deployment from argument or config defaults.
   * Does NOT check production access - caller must check if needed.
   * @param deployment - Optional deployment type from tool argument
   * @returns projectDir and deployment selection
   */
  resolveDeployment(deployment?: "dev" | "prod"): {
    projectDir: string;
    deployment: DeploymentSelectionWithinProject;
  } {
    const projectDir = this.options.projectDir ?? process.cwd();

    // Priority: tool argument > config flag > default (dev)
    const deploymentType = deployment ?? this.options.deployment ?? "dev";
    const deploymentSelection: DeploymentSelectionWithinProject =
      deploymentType === "prod" ? { kind: "prod" } : { kind: "ownDev" };

    return { projectDir, deployment: deploymentSelection };
  }

  /**
   * Resolve deployment and check production access if targeting prod.
   * Use this for tools that read production data.
   * @param deployment - Optional deployment type from tool argument
   * @returns projectDir and deployment selection
   */
  async resolveDeploymentWithAccessCheck(deployment?: "dev" | "prod"): Promise<{
    projectDir: string;
    deployment: DeploymentSelectionWithinProject;
  }> {
    const result = this.resolveDeployment(deployment);
    if (result.deployment.kind === "prod") {
      await this.assertProductionAccessEnabled();
    }
    return result;
  }

  /**
   * Check if production access is enabled. Call this before any prod operations.
   */
  async assertProductionAccessEnabled(): Promise<void> {
    if (this.options.disableProduction) {
      await this.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage:
          "Production access is disabled. Remove --disable-production to enable read access.",
      });
    }
  }

  /**
   * Check if production mutations are enabled. Call this before running mutations/actions on prod.
   */
  async assertProductionMutationsEnabled(): Promise<void> {
    // First check if production access is enabled at all
    await this.assertProductionAccessEnabled();

    if (!this.options.dangerouslyEnableProductionMutations) {
      await this.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage:
          "Running mutations on production is disabled. Start the MCP server with --dangerously-enable-production-mutations to enable.",
      });
    }
  }
}

export class RequestCrash {
  printedMessage: string;
  exitCode: number;
  errorType: ErrorType | undefined;
  constructor(
    exitCode: number,
    errorType: ErrorType | undefined,
    printedMessage: string | null,
  ) {
    this.exitCode = exitCode;
    this.errorType = errorType;
    this.printedMessage = printedMessage ?? "Unknown error";
  }
}
