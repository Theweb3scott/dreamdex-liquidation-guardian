import { createServerFn } from "@tanstack/react-start";
import type { DryRunResult } from "./hideki-preview";
import type { ExecMode } from "./execution";
import type { ProtocolResult } from "./hideki-read";
import type { WalletReviewResult } from "./review-read";
import type { StopPreviewResult } from "./stop-read";
import type { ShieldResult } from "./shield-read";

export const readProtocolAccount = createServerFn({ method: "POST" })
  .validator((account: unknown) => {
    if (account == null) return "";
    if (typeof account !== "string") throw new Error("Account must be a public address string.");
    return account.trim();
  })
  .handler(async ({ data }): Promise<ProtocolResult> => {
    const { readHidekiProtocol } = await import("./hideki-read.ts");
    return readHidekiProtocol(data);
  });

export const readGuardianShield = createServerFn({ method: "POST" })
  .validator((account: unknown) => {
    if (typeof account !== "string") throw new Error("Account must be a public address string.");
    return account.trim();
  })
  .handler(async ({ data }): Promise<ShieldResult> => {
    const { readGuardianShield: read } = await import("./shield-read.ts");
    return read(data);
  });

export const previewDryRun = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing preview input.");
    const raw = input as {
      account?: unknown;
      requestedPct?: unknown;
      maxPct?: unknown;
      mode?: unknown;
      journal?: unknown;
      includeWarning?: unknown;
    };
    if (typeof raw.account !== "string") throw new Error("Account must be a public address.");
    if (typeof raw.requestedPct !== "number" || typeof raw.maxPct !== "number") {
      throw new Error("Reduction percents must be numbers.");
    }
    if (raw.mode !== "demo" && raw.mode !== "protection") throw new Error("Mode must be demo or protection.");
    return {
      account: raw.account.trim(),
      requestedPct: raw.requestedPct,
      maxPct: raw.maxPct,
      mode: raw.mode as ExecMode,
      journal: typeof raw.journal === "string" ? raw.journal : null,
      includeWarning: raw.includeWarning === true,
    };
  })
  .handler(async ({ data }): Promise<DryRunResult> => {
    const { runDryRunPreview } = await import("./hideki-preview.ts");
    return runDryRunPreview(data.account, data.requestedPct, data.maxPct, data.mode, data.journal, data.includeWarning);
  });

export const readWalletReviewAccount = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing review input.");
    const raw = input as { account?: unknown; quantity?: unknown };
    if (typeof raw.account !== "string") throw new Error("Account must be the connected address.");
    if (raw.quantity != null && typeof raw.quantity !== "string") throw new Error("Quantity must be a raw integer string.");
    return { account: raw.account.trim(), quantity: typeof raw.quantity === "string" ? raw.quantity.trim() : null };
  })
  .handler(async ({ data }): Promise<WalletReviewResult> => {
    const { readWalletReview } = await import("./review-read.ts");
    return readWalletReview(data.account, data.quantity);
  });

export const previewProtectiveStopAccount = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing stop preview input.");
    const raw = input as { account?: unknown; quantity?: unknown };
    if (typeof raw.account !== "string") throw new Error("Account must be the connected address.");
    if (raw.quantity != null && typeof raw.quantity !== "string") throw new Error("Quantity must be a raw integer string.");
    return { account: raw.account.trim(), quantity: typeof raw.quantity === "string" ? raw.quantity.trim() : null };
  })
  .handler(async ({ data }): Promise<StopPreviewResult> => {
    const { readStopPreview } = await import("./stop-read.ts");
    return readStopPreview(data.account, data.quantity);
  });
