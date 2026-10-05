export type Files = Record<string, string>;
export type Role = 'agent' | 'runner' | 'human';
export interface Actor { id: string; role: Role }
export interface Patch { path: string; before: string | null; after: string | null }
export interface Context { summary: string; nextStep: string; notes: string[] }
export interface Task {
  id: string; title: string; agent: string; intent: string; paths: string[];
  baseRevision: number; baseFiles: Files; status: 'working' | 'proposed' | 'integrated';
  context: Context; patches: Patch[];
}
export interface Evidence { treeHash: string; passed: boolean; checks: string[]; runner: string }
export interface PublicationReceipt {
  ref: string; previousHead: string; commit: string; tree: string;
  contentHash: string; remote: string; publishedAt: string;
}
export interface Publication {
  treeHash: string; baseRevision: number; ref: string; expectedHead: string;
  status: 'reserved' | 'published'; reservedBy: string; receipt?: PublicationReceipt;
}
export interface Candidate {
  treeHash: string; baseRevision: number; files: Files; taskIds: string[];
  evidence?: Evidence; approval?: { treeHash: string; human: string };
}
export interface Event { sequence: number; type: string; actor: string; message: string }
export interface State {
  mode: 'local' | 'cloudflare'; objective: string; baseline: Files; revision: number;
  tasks: Task[]; candidate?: Candidate; publication?: Publication; events: Event[];
}
export type Action = (
  | { type: 'create_objective'; objective: string }
  | { type: 'create_task'; id: string; title: string; agent: string; intent: string; paths: string[] }
  | { type: 'checkpoint'; taskId: string; context: Context }
  | { type: 'propose'; taskId: string; patches: Patch[] }
  | { type: 'assemble'; taskIds: string[] }
  | { type: 'record_evidence'; evidence: Omit<Evidence, 'runner'> }
  | { type: 'approve'; treeHash: string }
  | { type: 'reserve_publication'; ref: string; expectedHead: string }
  | { type: 'record_publication'; receipt: PublicationReceipt }
  | { type: 'integrate' }
) & { actor: Actor };
