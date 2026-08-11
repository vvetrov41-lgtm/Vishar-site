import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { withConsequentialConfirmations } from './lib/consequential-client';
import { LanguageProvider } from './lib/i18n';
import { RouterProvider } from './lib/router';
import { SessionProvider } from './lib/session';
import { createCrmClient, readTeamInviteUrl } from './lib/supabase';
import './styles.css';

// `import.meta.env` is replaced at build time by Vite. Only VITE_-prefixed
// values are exposed to the bundle, which is one more reason a secret or
// service-role key can never end up here. Loopback HTTP is accepted only while
// Vite is actually in development mode; a production build remains hosted-
// Supabase-only.
const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
const client = withConsequentialConfirmations(createCrmClient(browserEnv, import.meta.env.DEV));
const teamInviteUrl = readTeamInviteUrl(browserEnv, import.meta.env.DEV);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <SessionProvider client={client} teamInviteUrl={teamInviteUrl}>
        <RouterProvider>
          <App />
        </RouterProvider>
      </SessionProvider>
    </LanguageProvider>
  </StrictMode>
);
