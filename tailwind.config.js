/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html","./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      keyframes: {
        shimmer: { "0%":{transform:"translateX(-100%)"}, "100%":{transform:"translateX(100%)"} },
        dot:     { "0%":{transform:"scale(.6)",opacity:.45}, "50%":{transform:"scale(1)",opacity:1}, "100%":{transform:"scale(.6)",opacity:.45} },
        sweep:   { "0%":{transform:"translateX(-100%)"}, "100%":{transform:"translateX(100%)"} },
      },
      animation: {
        shimmer: "shimmer 1.8s linear infinite",
        dot:     "dot 1.1s ease-in-out infinite",
        sweep:   "sweep 1.6s linear infinite",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
}
