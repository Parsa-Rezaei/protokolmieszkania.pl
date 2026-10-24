/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.html', './public/assets/app.js'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdaff',
          500: '#2f6fdf',
          600: '#1f57c3',
          700: '#1b459c',
          800: '#1c3c7c',
          900: '#1b3463'
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']
      }
    }
  },
  plugins: []
};
