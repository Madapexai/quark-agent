/**
 * Sandbox Policy — fine-grained control over what the sandbox can do
 *
 * Controls shell command allowlist/denylist, network access, filesystem access,
 * execution timeouts, and tool auto-approval modes.
 *
 * Policy can be created from environment variables, config file, or defaults.
 */

// ============================================================================
// Types
// ============================================================================

export interface SandboxPolicy {
  /** Shell command allowlist (if set, only these commands allowed) */
  shellAllowlist?: string[];
  /** Shell command denylist (these commands are always blocked) */
  shellDenylist?: string[];
  /** Whether to allow network access in sandbox */
  allowNetwork?: boolean;
  /** Whether to allow filesystem access */
  allowFilesystem?: boolean;
  /** Max execution time in ms */
  maxTimeoutMs?: number;
  /** Tool auto-approve mode: "all" | "safe" | "none" */
  toolAutoApprove?: "all" | "safe" | "none";
  /** Safe tools that don't need approval (read-only, no side effects) */
  safeTools?: string[];
}

// ============================================================================
// Default Policy
// ============================================================================

export const DEFAULT_POLICY: SandboxPolicy = {
  shellDenylist: [
    "rm -rf /",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
  ],
  allowNetwork: true,
  allowFilesystem: true,
  maxTimeoutMs: 30_000,
  toolAutoApprove: "safe",
  safeTools: [
    "memory_recall",
    "code_exec",
    "http_get",
    "web_fetch",
    "web_search",
    "file_read",
    "glob",
    "grep",
    "ls",
  ],
};

// ============================================================================
// Policy checks
// ============================================================================

/**
 * Check if a shell command is allowed by policy.
 *
 * Logic:
 * 1. If the command matches any entry in shellDenylist, it is blocked.
 * 2. If shellAllowlist is set, the command must match an entry to be allowed.
 * 3. If no shellAllowlist, the command is allowed (denylist already checked).
 */
export function isCommandAllowed(policy: SandboxPolicy, command: string): boolean {
  const normalized = command.trim().toLowerCase();

  // 1. Check denylist — always blocked
  const denylist = policy.shellDenylist ?? DEFAULT_POLICY.shellDenylist!;
  for (const denied of denylist) {
    if (normalized.startsWith(denied.toLowerCase()) || normalized.includes(denied.toLowerCase())) {
      return false;
    }
  }

  // 2. Check allowlist — if set, only these are allowed
  if (policy.shellAllowlist && policy.shellAllowlist.length > 0) {
    const baseCmd = normalized.split(/\s+/)[0];
    return policy.shellAllowlist.some((allowed) => {
      const allowedBase = allowed.trim().toLowerCase().split(/\s+/)[0];
      return baseCmd === allowedBase;
    });
  }

  // 3. No allowlist → allowed (denylist already passed)
  return true;
}

/**
 * Check if a tool needs approval before execution.
 *
 * Modes:
 * - "all": no tool needs approval
 * - "safe": tools in safeTools list are auto-approved, others need approval
 * - "none": every tool needs approval
 */
export function toolNeedsApproval(policy: SandboxPolicy, toolName: string): boolean {
  const mode = policy.toolAutoApprove ?? DEFAULT_POLICY.toolAutoApprove!;

  switch (mode) {
    case "all":
      return false;
    case "none":
      return true;
    case "safe": {
      const safeTools = policy.safeTools ?? DEFAULT_POLICY.safeTools!;
      return !safeTools.includes(toolName);
    }
  }
}

/**
 * Create a SandboxPolicy from environment variables.
 *
 * Environment variables:
 * - QUARK_SANDBOX_AUTO_APPROVE: "all" | "safe" | "none"
 * - QUARK_SANDBOX_NETWORK: "true" | "false"
 * - QUARK_SANDBOX_FS: "true" | "false"
 * - QUARK_SANDBOX_TIMEOUT: number in ms
 * - QUARK_SANDBOX_DENY: comma-separated denylist additions
 * - QUARK_SANDBOX_ALLOW: comma-separated allowlist (sets shellAllowlist)
 * - QUARK_SANDBOX_SAFE_TOOLS: comma-separated safe tool names
 */
export function policyFromEnv(): SandboxPolicy {
  const policy: SandboxPolicy = { ...DEFAULT_POLICY };

  const autoApprove = process.env.QUARK_SANDBOX_AUTO_APPROVE;
  if (autoApprove === "all" || autoApprove === "safe" || autoApprove === "none") {
    policy.toolAutoApprove = autoApprove;
  }

  const network = process.env.QUARK_SANDBOX_NETWORK;
  if (network !== undefined) {
    policy.allowNetwork = network === "true";
  }

  const fs = process.env.QUARK_SANDBOX_FS;
  if (fs !== undefined) {
    policy.allowFilesystem = fs === "true";
  }

  const timeout = process.env.QUARK_SANDBOX_TIMEOUT;
  if (timeout !== undefined) {
    const ms = parseInt(timeout, 10);
    if (!isNaN(ms) && ms > 0) {
      policy.maxTimeoutMs = ms;
    }
  }

  const deny = process.env.QUARK_SANDBOX_DENY;
  if (deny) {
    const additions = deny.split(",").map((s) => s.trim()).filter(Boolean);
    policy.shellDenylist = [...(policy.shellDenylist ?? []), ...additions];
  }

  const allow = process.env.QUARK_SANDBOX_ALLOW;
  if (allow) {
    policy.shellAllowlist = allow.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const safeTools = process.env.QUARK_SANDBOX_SAFE_TOOLS;
  if (safeTools) {
    policy.safeTools = safeTools.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return policy;
}

/**
 * Create a named preset policy.
 *
 * - "strict": no network, no filesystem, no shell, approve none
 * - "balanced": network ok, filesystem ok, denylist only, approve safe
 * - "permissive": everything allowed, approve all
 */
export function presetPolicy(name: "strict" | "balanced" | "permissive"): SandboxPolicy {
  switch (name) {
    case "strict":
      return {
        shellAllowlist: [],
        shellDenylist: [
          "rm -rf /",
          "mkfs",
          "dd if=",
          ":(){ :|:& };:",
          "shutdown",
          "reboot",
          "curl",
          "wget",
          "nc",
          "ssh",
        ],
        allowNetwork: false,
        allowFilesystem: false,
        maxTimeoutMs: 5_000,
        toolAutoApprove: "none",
        safeTools: ["memory_recall", "file_read", "glob", "grep", "ls"],
      };
    case "balanced":
      return { ...DEFAULT_POLICY };
    case "permissive":
      return {
        shellDenylist: ["rm -rf /", ":(){ :|:& };:"],
        allowNetwork: true,
        allowFilesystem: true,
        maxTimeoutMs: 120_000,
        toolAutoApprove: "all",
        safeTools: DEFAULT_POLICY.safeTools,
      };
  }
}
