import { apiInvoke } from "./index";

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}

export const getWorkspaces = () => apiInvoke<Workspace[]>("get_workspaces");
export const createWorkspace = (name: string) => apiInvoke<Workspace>("create_workspace", { name });
export const updateWorkspace = (id: string, name: string) => apiInvoke<Workspace>("update_workspace", { id, name });
export const deleteWorkspace = (id: string) => apiInvoke<{ id: string }>("delete_workspace", { id });
