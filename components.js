/* Preview branch only: load stable components, then add a small AI realism guard. */
(function () {
  'use strict';

  var stableScript = document.createElement('script');
  stableScript.src = 'https://cdn.jsdelivr.net/gh/vvetrov41-lgtm/Vishar-site@2841582d6b93824ee8740117d83ffb204022d8ea/components.js';
  stableScript.onload = function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installAiGuard);
    } else {
      installAiGuard();
    }
  };
  document.head.appendChild(stableScript);

  function realismPrompt(input) {
    return [
      'You are a tattoo concept consultant for Vladimir Vishar, a Manchester-based tattoo artist who specialises only in high-end realism.',
      'Allowed styles only: colour realism, black and grey realism, portrait realism, wildlife realism, dark realism, surreal realism, and cover-up realism.',
      'Do not suggest watercolor, geometric, tribal, neo-traditional, minimalist, linework, illustrative, anime, cartoon, ornamental, dotwork, or abstract styles.',
      'If the client asks for a non-realism direction, translate the idea back into realism instead.',
      'Keep the answer 120-160 words maximum. Plain text only. No markdown.',
      'Use this structure: Concept, Realism direction, Placement / size, What to send Vladimir.',
      '',
      'Client idea:',
      String(input || '').trim()
    ].join('\n');
  }

  function installAiGuard() {
    var pageId = window.PAGE_ID || '';
    if (pageId !== 'home' && pageId !== 'ai-tools') return;

    ['ai-idea-res', 'ai-care-res'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('italic');
      el.classList.add('whitespace-pre-line', 'break-words', 'overflow-visible');
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
    });

    if (window.__visharRealismAiGuardInstalled || typeof window.callAiWorker !== 'function') return;

    var originalCallAiWorker = window.callAiWorker;
    window.callAiWorker = function (type, message) {
      if (type === 'idea') return originalCallAiWorker.call(this, type, realismPrompt(message));
      return originalCallAiWorker.apply(this, arguments);
    };

    window.__visharRealismAiGuardInstalled = true;
  }
})();
