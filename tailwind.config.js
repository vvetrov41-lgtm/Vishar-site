/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './about/index.html',
    './faq/index.html',
    './aftercare/index.html',
    './ai-tools/index.html',
    './black-and-grey-realism-manchester/index.html',
    './colour-realism-tattoo-manchester/index.html',
    './cover-up-tattoo-manchester/index.html',
    './components.js'
  ],
  theme: {
    extend: {
      colors: {
        apple: {
          black: '#000000',
          darkGray: '#1d1d1f',
          lightGray: '#f5f5f7',
          blue: '#0071e3',
          muted: '#8e8e93'
        }
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['Playfair Display', 'serif'],
        display: ['Playfair Display', 'serif']
      }
    }
  },
  safelist: [
    'text-white',
    'bg-apple-black',
    'text-apple-blue',
    'text-apple-muted',
    'font-display',
    'hover:text-white/80',
    'hidden',
    'mobile-overlay-enter',
    'lightbox-active',
    'hidden-cta',
    'reveal',
    'visible',
    'hero-parallax',
    'motion-ready',
    'translate-y-8',
    'lg:grid-cols-3'
  ]
};
