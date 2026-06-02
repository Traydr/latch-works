/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          DEFAULT: '#f4f5f8',
          dark: '#1b1d22',
        },
      },
      boxShadow: {
        app: '0 10px 40px rgba(0, 0, 0, 0.16)',
      },
    },
  },
  plugins: [],
};
