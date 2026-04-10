/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0A131E',
          card: '#0D1B2A',
          border: '#1A2A3D',
          light: '#1E2F45',
        },
        accent: {
          DEFAULT: '#1993C5',
          light: '#74DFF6',
          hover: '#1578A2',
        },
        text: {
          DEFAULT: '#B0BEC5',
          muted: '#6B7E8F',
          bright: '#E0E8EE',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
