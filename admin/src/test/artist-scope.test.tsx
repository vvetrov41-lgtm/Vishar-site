import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { createApi } from '../lib/api';
import { ARTIST_SCOPE_STORAGE_KEY } from '../lib/artist-scope';
import { translate } from '../lib/i18n';
import {
  createFakeClient, renderWithSession,
  VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID,
} from './fixtures';

beforeEach(() => window.localStorage.clear());

describe('artist scope', () => {
  it('uses the controlled All assigned artists wording in EN and RU', () => {
    expect(translate('en','artistScope.allAssigned')).toBe('All assigned artists');
    expect(translate('ru','artistScope.allAssigned')).toBe('Все назначенные мастера');
  });

  it('renders only identities returned by list_accessible_artists', async () => {
    renderWithSession(<App />,{
      role:'booking_manager',
      accessibleArtistIds:[VLADIMIR_ARTIST_ID],
    });
    const selector=await screen.findByLabelText('Artist');
    expect(selector).toHaveTextContent('All assigned artists');
    expect(selector).toHaveTextContent('Vladimir Vishar');
    expect(selector).not.toHaveTextContent('Kristina Vishar');
  });

  it('supports a manager assigned to both artists without inventing options', async () => {
    renderWithSession(<App />,{
      role:'booking_manager',
      accessibleArtistIds:[VLADIMIR_ARTIST_ID,KRISTINA_ARTIST_ID],
    });
    const selector=await screen.findByLabelText('Artist');
    expect(selector).toHaveTextContent('Vladimir Vishar');
    expect(selector).toHaveTextContent('Kristina Vishar');
  });

  it('propagates artist_id to every artist-scoped list API', async () => {
    const queryCalls:{table:string;method:string;args:unknown[]}[]=[];
    const api=createApi(createFakeClient({role:'owner',queryCalls}));
    await Promise.all([
      api.listEnquiries({artistId:VLADIMIR_ARTIST_ID}),
      api.listProjects(undefined,VLADIMIR_ARTIST_ID),
      api.listSessions(undefined,VLADIMIR_ARTIST_ID),
      api.listFollowUps({open:true,artistId:VLADIMIR_ARTIST_ID}),
      api.listActivity({artistId:VLADIMIR_ARTIST_ID}),
      api.listFailedJobs(VLADIMIR_ARTIST_ID),
    ]);
    for(const table of ['enquiries','projects','sessions','follow_ups','activity_log','integration_outbox']){
      expect(queryCalls).toContainEqual({
        table,method:'eq',args:['artist_id',VLADIMIR_ARTIST_ID],
      });
    }
    expect(queryCalls.some(call=>call.table==='clients'&&call.args[0]==='artist_id')).toBe(false);
  });

  it('applies the selected artist to page reads', async () => {
    const queryCalls:{table:string;method:string;args:unknown[]}[]=[];
    renderWithSession(<App />,{
      role:'owner',path:'/enquiries',queryCalls,
      accessibleArtistIds:[VLADIMIR_ARTIST_ID,KRISTINA_ARTIST_ID],
    });
    const selector=await screen.findByLabelText('Artist');
    fireEvent.change(selector,{target:{value:KRISTINA_ARTIST_ID}});
    await waitFor(()=>expect(queryCalls).toContainEqual({
      table:'enquiries',method:'eq',args:['artist_id',KRISTINA_ARTIST_ID],
    }));
  });

  it('resets a stale persisted artist after access changes', async () => {
    window.localStorage.setItem(ARTIST_SCOPE_STORAGE_KEY,KRISTINA_ARTIST_ID);
    renderWithSession(<App />,{
      role:'booking_manager',accessibleArtistIds:[VLADIMIR_ARTIST_ID],
    });
    const selector=await screen.findByLabelText('Artist');
    await waitFor(()=>expect(selector).toHaveValue(''));
    expect(window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY)).toBeNull();
  });

  it('keeps the owner combined view explicit and unfiltered by default', async () => {
    const queryCalls:{table:string;method:string;args:unknown[]}[]=[];
    renderWithSession(<App />,{
      role:'owner',queryCalls,
      accessibleArtistIds:[VLADIMIR_ARTIST_ID,KRISTINA_ARTIST_ID],
    });
    expect(await screen.findByLabelText('Artist')).toHaveValue('');
    await waitFor(()=>expect(queryCalls.some(call=>call.table==='enquiries')).toBe(true));
    expect(queryCalls.some(call=>call.method==='eq'&&call.args[0]==='artist_id')).toBe(false);
  });
});
