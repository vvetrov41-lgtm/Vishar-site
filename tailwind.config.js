/** @type {import(‘tailwindcss’).Config} */
module.exports = {
content: [
“./index.html”,
“./components.js”,
“./colour-realism-tattoo-manchester/**/*.html”,
“./black-and-grey-realism-manchester/**/*.html”,
“./cover-up-tattoo-manchester/**/*.html”,
“./about/**/*.html”,
“./aftercare/**/*.html”,
“./faq/**/*.html”,
“./ai-tools/**/*.html”
],
theme: {
extend: {
colors: {
apple: {
black: ‘#000000’,
darkGray: ‘#1d1d1f’,
lightGray: ‘#f5f5f7’,
blue: ‘#0071e3’
}
},
fontFamily: {
sans: [‘Inter’, ‘-apple-system’, ‘BlinkMacSystemFont’, ‘Segoe UI’, ‘sans-serif’],
serif: [‘Playfair Display’, ‘Georgia’, ‘serif’]
}
}
},
plugins: []
}