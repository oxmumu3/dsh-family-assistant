import { createOwnerAgentClient } from './owner-agent-client.mjs';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** In-process Owner adapter for official Host controllers.
 *
 * Direct controller calls are trusted same-process Owner calls. The caller must
 * authenticate the Owner and persist the dedicated family_owner_UUID session
 * and request identities before dispatch. Never use this adapter for a family
 * member: ordinary native create/prompt APIs have no per-request tool ACL.
 */
export function createOwnerAgentHost({ workspaceController, sessionController, controlWorkspacePath, timeoutMs = 30_000 } = {}) {
  const fail = code => Object.assign(new Error(code), { code });
  const method = (controller, name) => {
    if (typeof controller?.[name] !== 'function') throw fail('owner_agent_controller_unavailable');
    return controller[name].bind(controller);
  };
  const plain = (value, valid) => {
    // These are in-process service methods, not Typert Remote clients. Reject
    // an accidental Remote envelope rather than wrapping it a second time.
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'ok') || !valid(value)) {
      throw fail('owner_agent_remote_failed');
    }
    return { ok: true, value };
  };
  const remote = {
    workspace: {
      follow: signal => method(workspaceController, 'follow')(signal),
      create: async request => plain(await method(workspaceController, 'create')(request), value => value.workspace && typeof value.workspace.workspaceId === 'string'),
    },
    session: {
      // Official create takes one argument; prompt/follow/page take a signal.
      create: async request => plain(await method(sessionController, 'create')(request), value => typeof value.sessionId === 'string' && value.sessionId.length > 0),
      prompt: async (request, signal) => plain(await method(sessionController, 'prompt')(request, signal), value => value.accepted === true),
      follow: (request, signal) => method(sessionController, 'follow')(request, signal),
      page: async (request, signal) => plain(await method(sessionController, 'page')(request, signal), value => Array.isArray(value.records)),
    },
  };
  // The existing adapter owns bounds, aborts, workspace/session verification,
  // native rpcId correlation, pagination, and duplicate-admission protection.
  const client = createOwnerAgentClient({ remote, timeoutMs });
  async function ensureControlWorkspace({ signal } = {}) {
    if (signal?.aborted) throw fail('owner_agent_cancelled');
    if (typeof controlWorkspacePath !== 'string' || !controlWorkspacePath || controlWorkspacePath.length > 4096 || /[\x00-\x1f\x7f]/u.test(controlWorkspacePath) || !isAbsolute(controlWorkspacePath)) throw fail('owner_agent_control_workspace_invalid');
    const path = resolve(controlWorkspacePath);
    let canonical;
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('owner_agent_control_workspace_invalid');
      canonical = realpathSync(path);
    } catch { throw fail('owner_agent_control_workspace_invalid'); }
    const workspace = await client.addWorkspace(canonical, { signal });
    if (workspace.path !== canonical) throw fail('owner_agent_identity_mismatch');
    // Recheck after asynchronous registration so a replaced directory cannot
    // silently change the control Session's filesystem root.
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== canonical) throw fail('owner_agent_control_workspace_invalid');
    } catch { throw fail('owner_agent_control_workspace_invalid'); }
    return workspace;
  }
  return Object.freeze({ ensureControlWorkspace, listWorkspaces: client.listWorkspaces, start: client.start, observe: client.observe });
}
