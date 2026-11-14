import { apiMessage, ApiError, friendlyMessage, type CrmClient, type ApiOperation } from './api';
import type { Project, ProjectStatus } from './types';

function unwrap<T>(result: { data: T | null; error: any }, what: ApiOperation): T {
  if (result.error) throw new ApiError(friendlyMessage(result.error, what), result.error);
  return result.data as T;
}

export function createProjectOperationsApi(client: CrmClient) {
  return {
    /** The request UUID is stable across retries, so a lost response cannot
     * create a second tattoo project for the same client. */
    async createClientProject(input: {
      requestId: string;
      clientId: string;
      artistId: string;
      title: string;
      description: string | null;
    }) {
      return unwrap<{ project_id: string; created: boolean }>(
        await client.rpc('create_client_project', {
          p_project_id: input.requestId,
          p_client_id: input.clientId,
          p_artist_id: input.artistId,
          p_title: input.title.trim(),
          p_description: input.description?.trim() || null,
        }),
        'create that client project'
      );
    },

    async updateProjectDescription(projectId: string, description: string, expectedDescription: string | null) {
      const result = await client.rpc('update_project_description', {
        p_project_id: projectId,
        p_description: description.trim() || null,
        p_expected_description: expectedDescription,
      });
      if (result.error?.hint === 'PROJECT_EDIT_CONFLICT') {
        throw new ApiError(apiMessage('The project changed while it was open. Reload it before saving again.'), result.error);
      }
      return unwrap<{ project_id: string; changed: boolean }>(result, 'edit that project description');
    },

    async setProjectArchiveState(projectId: string, archived: boolean) {
      return unwrap<{ project_id: string; archived: boolean; changed: boolean }>(
        await client.rpc('set_project_archive_state', {
          p_project_id: projectId,
          p_archived: archived,
        }),
        archived ? 'archive that project' : 'restore that project'
      );
    },

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
