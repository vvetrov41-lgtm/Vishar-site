import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { DepositStatus, Project, ProjectStatus } from './types';

function unwrap<T>(result: { data: T | null; error: any }, what: string): T {
  if (result.error) throw new ApiError(friendlyMessage(result.error, what), result.error);
  return result.data as T;
}

export function createProjectOperationsApi(client: CrmClient) {
  return {
    async updateProjectEstimate(input: {
      projectId: string;
      hourlyRate: number | null;
      estimateTotal: number | null;
      estimatedSessions: number | null;
      estimatedHours: number | null;
      currency?: string;
    }) {
      return unwrap<Record<string, unknown>>(
        await client.rpc('update_project_estimate', {
          p_project_id: input.projectId,
          p_hourly_rate: input.hourlyRate,
          p_estimate_total: input.estimateTotal,
          p_estimated_sessions: input.estimatedSessions,
          p_estimated_hours: input.estimatedHours,
          p_currency: input.currency ?? null,
        }),
        'update that project estimate'
      );
    },

    async setProjectStatus(projectId: string, status: ProjectStatus) {
      return unwrap<{ project_id: string; status: ProjectStatus; changed: boolean }>(
        await client.rpc('set_project_status', {
          p_project_id: projectId,
          p_status: status,
        }),
        'change that project status'
      );
    },

    async setProjectDepositRequirement(projectId: string, required: boolean) {
      return unwrap<{ project_id: string; deposit_status: DepositStatus; required: boolean }>(
        await client.rpc('set_project_deposit_requirement', {
          p_project_id: projectId,
          p_required: required,
        }),
        'change that project deposit requirement'
      );
    },

    async createAppointmentInternalNote(sessionId: string, body: string) {
      return unwrap<string>(
        await client.rpc('create_internal_note', {
          p_body: body,
          p_client_id: null,
          p_enquiry_id: null,
          p_project_id: null,
          p_session_id: sessionId,
        }),
        'save that appointment note'
      );
    },

    async getProjectOperationalStatus(projectId: string): Promise<Pick<Project, 'id' | 'status'> | null> {
      const result = await client
        .from('projects')
        .select('id, status')
        .eq('id', projectId)
        .maybeSingle();
      if (result.error) throw new ApiError(friendlyMessage(result.error, 'load project status'), result.error);
      return (result.data as Pick<Project, 'id' | 'status'>) ?? null;
    },
  };
}

export type ProjectOperationsApi = ReturnType<typeof createProjectOperationsApi>;
