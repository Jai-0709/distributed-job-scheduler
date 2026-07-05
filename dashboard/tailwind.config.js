/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        bg: {
          base: '#0d1117',
          surface: '#161b22',
          elevated: '#21262d',
          border: '#30363d',
        },
        accent: {
          DEFAULT: '#00d4aa',
          dim: '#00b894',
          muted: 'rgba(0,212,170,0.1)',
        },
        status: {
          queued: '#6366f1',
          scheduled: '#8b5cf6',
          claimed: '#f59e0b',
          running: '#3b82f6',
          completed: '#10b981',
          failed: '#ef4444',
          dead_letter: '#dc2626',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
