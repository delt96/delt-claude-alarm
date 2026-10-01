export interface ApprovalChoice {
  label: string;
  response: unknown;
}

export interface ApprovalView {
  toolName: string;
  description: string;
  inputPreview: string;
  choices: ApprovalChoice[];
}

export interface FileChange {
  path: string;
  diff: string;
}

const DECISION_LABELS: Record<string, string> = {
  accept: 'Allow once',
  acceptForSession: 'Allow for this session',
  acceptWithExecpolicyAmendment: 'Always allow this command',
  decline: 'Decline',
  cancel: 'Cancel task',
};

export function decisionLabel(decision: unknown): string {
  if (typeof decision === 'string') return DECISION_LABELS[decision] ?? decision;
  const [key, value] = Object.entries(decision ?? {})[0] ?? [];
  if (key === 'applyNetworkPolicyAmendment') {
    const rule = (value as { network_policy_amendment?: { host?: string; action?: string } } | undefined)?.network_policy_amendment;
    return `Network rule: ${rule?.host ?? 'unknown host'} ${rule?.action ?? ''}`.trim();
  }
  return key ? (DECISION_LABELS[key] ?? key) : 'Unknown';
}

function decisions(offered: unknown[]): ApprovalChoice[] {
  return offered.map((decision) => ({ label: decisionLabel(decision), response: { decision } }));
}

export function fileChanges(item: { changes?: Array<{ path?: string; diff?: string }> }): FileChange[] {
  return (item.changes ?? []).map((c) => ({ path: String(c.path ?? ''), diff: String(c.diff ?? '') }));
}

export function approvalView(method: string, params: any, files: FileChange[] = []): ApprovalView | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // availableDecisions is sent by Codex 0.159.3 but absent from its generated schema.
      const offered: unknown[] =
        Array.isArray(params.availableDecisions) && params.availableDecisions.length
          ? params.availableDecisions
          : ['accept', 'decline', 'cancel'];
      const command = params.command ?? (params.commandActions ?? []).map((a: { command: string }) => a.command).join('\n');
      return {
        toolName: 'Command',
        description: params.reason || 'Codex wants to run a command.',
        inputPreview: JSON.stringify({ command: String(command) }),
        choices: decisions(offered),
      };
    }
    case 'item/fileChange/requestApproval': {
      // The request names only the item; the file list arrives earlier in item/started.
      const content = files.length
        ? files.map((f) => (f.diff ? `${f.path}\n${f.diff}` : f.path)).join('\n\n')
        : 'The file list is not available here. Check the Codex window.';
      return {
        toolName: 'File change',
        description: params.reason || 'Codex wants to change files.',
        inputPreview: JSON.stringify({ content }),
        choices: decisions(['accept', 'acceptForSession', 'decline', 'cancel']),
      };
    }
    case 'mcpServer/elicitation/request':
      if (params._meta?.codex_approval_kind !== 'mcp_tool_call') return null;
      return {
        toolName: 'MCP tool',
        description: `MCP server: ${params.serverName ?? 'unknown'}`,
        inputPreview: JSON.stringify({ content: String(params.message ?? '') }),
        choices: [
          { label: 'Allow', response: { action: 'accept', content: {} } },
          { label: 'Decline', response: { action: 'decline' } },
          { label: 'Cancel', response: { action: 'cancel' } },
        ],
      };
    default:
      return null;
  }
}
