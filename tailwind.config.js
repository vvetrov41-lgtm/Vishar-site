/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./*.html', './index.html'],
  theme: {
    extend: {
      colors: {
        apple: {
          black: '#000000',
          darkGray: '#1d1d1f',
          lightGray: '#f5f5f7',
          blue: '#0071e3'
        }
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['Playfair Display', 'serif']
      }
    }
  },
  plugins: []
}
