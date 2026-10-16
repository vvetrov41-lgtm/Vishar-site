// Statistics rendered from the test fixtures, for scripts/check-mobile-layout.mjs.
// Never built or deployed: it exists only for the layout check.
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { LanguageProvider } from '../src/lib/i18n';
import { RouterProvider } from '../src/lib/router';
import { SessionProvider } from '../src/lib/session';
import { SurfaceProvider } from '../src/lib/surface';
import { createFakeClient, statisticsResult } from '../src/test/fixtures';
import '../src/styles.css';
import '../src/booking-controls.css';
import '../src/mobile-overflow.css';

// The busiest realistic first screen: every "Needs attention" item at once.
const statistics = statisticsResult(true) as any;
statistics.from = '2026-10-05T23:00:00Z';
statistics.artists[0].current.consultations_awaiting_outcome = 2;

const client = createFakeClient({ role: 'owner', statistics } as never);
createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <SurfaceProvider surface="internal">
      <SessionProvider client={client}>
        <RouterProvider initialPath="/statistics">
          <App />
        </RouterProvider>
      </SessionProvider>
    </SurfaceProvider>
  </LanguageProvider>,
);
