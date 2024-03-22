import type { TriggerConfig } from "@trigger.dev/sdk/v3";

export const config: TriggerConfig = {
  project: "proj_olbfrbvscqekuyhsrzst",
  triggerDirectories: ["./lib/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dependenciesToBundle: [/@sindresorhus/, "escape-string-regexp"],
  additionalFiles: ["./prisma/schema.prisma"],
  additionalPackages: ["prisma@5.11.0"],
};
