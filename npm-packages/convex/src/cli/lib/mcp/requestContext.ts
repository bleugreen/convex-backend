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
  dangerouslyEnableProductionRun?: boolean;
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
   * Check if production run is enabled. Call this before running mutations/actions on prod.
   */
  async assertProductionRunEnabled(): Promise<void> {
    if (!this.options.dangerouslyEnableProductionRun) {
      await this.crash({
        exitCode: 1,
        errorType: "fatal",
        printedMessage:
          "Running functions on production is disabled. Start the MCP server with --dangerously-enable-production-run to enable.",
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
