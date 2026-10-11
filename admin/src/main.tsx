import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { withConsequentialConfirmations } from './lib/consequential-client';
import { LanguageProvider } from './lib/i18n';
import { initAnalytics, readAnalyticsConfig } from './lib/product-analytics';
import { RouterProvider } from './lib/router';
import { SessionProvider } from './lib/session';
import { SurfaceProvider, readSurface } from './lib/surface';
import { createCrmClient, isStaffInviteUrl, readTeamInviteUrl } from './lib/supabase';
import { captureEmbeddedSignupCallbackAtStartup } from './lib/meta-whatsapp-signup-redirect';
import './styles.css';
import './booking-controls.css';
import './mobile-overflow.css';

// `import.meta.env` is replaced at build time by Vite. Only VITE_-prefixed
// values are exposed to the bundle, which is one more reason a secret or
// service-role key can never end up here. Loopback HTTP is accepted only while
// Vite is actually in development mode; a production build remains hosted-
// Supabase-only.
const browserEnv = import.meta.env as unknown as Record<string, string | undefined>;
// Meta's Embedded Signup redirect lands on the root with ?code&state. Take it
// (single use) and move to the WhatsApp page before anything reads the URL.
captureEmbeddedSignupCallbackAtStartup();
const staffInviteMode = isStaffInviteUrl(window.location.href);
const client = withConsequentialConfirmations(
  createCrmClient(browserEnv, import.meta.env.DEV, window.location.href)
);
const teamInviteUrl = readTeamInviteUrl(browserEnv, import.meta.env.DEV);
// Which host this bundle is built for. Unset means public: see lib/surface.
const surface = readSurface(browserEnv);
// Explicit product analytics. Stays off unless the build carries an approved
// PostHog project key and ingestion host; see lib/product-analytics.
initAnalytics(readAnalyticsConfig(browserEnv));

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <SurfaceProvider surface={surface}>
      <SessionProvider
        client={client}
        teamInviteUrl={teamInviteUrl}
        staffInviteMode={staffInviteMode}
      >
        <RouterProvider>
          <App />
        </RouterProvider>
      </SessionProvider>
      </SurfaceProvider>
    </LanguageProvider>
  </StrictMode>
);
