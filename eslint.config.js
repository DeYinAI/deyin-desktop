import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/release/**",
      "**/out/**",
      "**/build/**",
      "**/.vite/**",
      "apps/desktop/bundled-plugins/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // A hook placed after an early return crashes the tree on the state
    // transition that flips the branch (v1.0.11's blank screen on New Chat,
    // React error #300). The renderer has no DOM-rendering tests, so this
    // rule is the only automated guard for it.
    files: ["packages/ui/client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Pre-existing dead assignments in the renderer; not worth failing the
      // hotfix over — they predate lint coverage of this package.
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        Bun: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
