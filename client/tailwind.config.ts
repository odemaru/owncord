import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          0: '#0b0c10',
          1: '#111318',
          2: '#171a21',
          3: '#1f232c',
        },
        border: {
          DEFAULT: '#242833',
        },
        accent: {
          DEFAULT: '#7c6cff',
          hover: '#6b5bff',
        },
        danger: {
          DEFAULT: '#ef4444',
          hover: '#dc2626',
        },
        success: {
          DEFAULT: '#22c55e',
        },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        soft: '0 10px 40px -10px rgba(0,0,0,0.6)',
      },
    },
  },
  plugins: [],
} satisfies Config;
