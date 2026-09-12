// ESLint flat configuration. Run it with `npm run lint`.
//
// Three layers: the JS baseline everywhere, the TypeScript rules on `src/`, and a
// relaxed layer for the helper scripts, which are plain Node modules that print to
// stdout on purpose.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["error", "warn"] }],
      "no-var": "error",
      "object-shorthand": ["error", "properties"],
      "prefer-const": "error",
    },
  },

  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // `_`-prefixed bindings are the usual way of marking something as deliberately
      // unused (destructured rest, placeholder callback arguments).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The CLI returns whatever Obsidian printed, so `unknown`/`any` do show up at
      // the boundary; flag them as warnings instead of failing the build.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  {
    // `scripts/` is developer tooling: the smoke test is meant to print its findings.
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
    },
  }
);
