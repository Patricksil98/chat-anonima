/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",   // tutti i file dentro src
    "./components/**/*.{js,ts,jsx,tsx}", // eventuali componenti riutilizzabili
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

