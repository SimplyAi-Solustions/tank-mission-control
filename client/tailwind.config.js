/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        surface: '#18181b',
        'surface-hover': '#27272a',
        border: '#27272a',
        accent: '#f97316',
      }
    }
  },
  plugins: []
};
